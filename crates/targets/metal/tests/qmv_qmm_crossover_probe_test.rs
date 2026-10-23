// SPDX-License-Identifier: Apache-2.0
//! LOCAL PROBE (not for commit): matvec (fold / wide) vs qmm_t (Standard or
//! SplitK + reduce, as `pick_qmm_t_kernel` routes) at 8..32 rows on real model
//! shapes. Weights rotate past the SLC; every dispatch is barriered.
//!
//! Run: cargo test -p scratchy-target-metal --release --test qmv_qmm_crossover_probe_test -- \
//!     --ignored --nocapture

mod common;

use objc2_metal::{MTLDevice as _, MTLSize};
use scratchy_target_metal::aot::{BakedPipeline, baked_pipeline};
use scratchy_target_metal::device::detect_device;
use scratchy_target_metal::mtl4_dispatch::{Mtl4DispatchBatch, shared_zeroed};
use scratchy_target_metal::quantized::{
    DequantDtype, QmmTKernel, ScaleDtype, pick_qmm_t_kernel, pick_qmv_kernel_wide,
    qmm_t_dispatch_shape, qmm_t_kernel_name, qmv_dispatch_shape, qmv_kernel_name,
    splitk_reduce_kernel_static_name,
};
use scratchy_target_metal::specialized_pipeline_cache::ConstantValue;

const ITERS: usize = 256;
const ROTATE_BYTES: usize = 512 << 20;
const GS: usize = 64;

struct Mat {
    w: common::Buffer,
    s: common::Buffer,
    b: common::Buffer,
}

fn fill(buf: &common::Buffer, seed: u8) {
    use objc2_metal::MTLBuffer as _;
    let len = buf.length();
    let p = buf.contents().as_ptr() as *mut u8;
    for i in 0..len {
        unsafe { *p.add(i) = if i % 2 == 1 { 0x20 } else { (i as u8).wrapping_mul(31) ^ seed } };
    }
}

fn sz(a: (u32, u32, u32)) -> MTLSize {
    MTLSize { width: a.0 as usize, height: a.1 as usize, depth: a.2 as usize }
}

/// One timed path: a matmul dispatch writing `out` (y or scratch), plus an
/// optional split-K reduce (scratch → y).
struct Path {
    pso: BakedPipeline,
    grid: MTLSize,
    tg: MTLSize,
    to_scratch: bool,
    reduce: Option<(BakedPipeline, MTLSize, MTLSize)>,
}

fn time(
    device: &common::Device,
    p: &Path,
    mats: &[Mat],
    x: &common::Buffer,
    y: &common::Buffer,
    scratch: &common::Buffer,
) -> f64 {
    let mut batch = Mtl4DispatchBatch::begin(device).expect("mtl4 batch");
    for i in 0..ITERS {
        let m = &mats[i % mats.len()];
        let out = if p.to_scratch { scratch } else { y };
        batch.encode(
            &p.pso,
            &[(&m.w, 0), (&m.s, 1), (&m.b, 2), (x, 3), (out, 4)],
            &[],
            &[],
            &[],
            p.grid,
            p.tg,
        );
        batch.barrier();
        if let Some((r, g, t)) = &p.reduce {
            batch.encode(r, &[(y, 0), (scratch, 1)], &[], &[], &[], *g, *t);
            batch.barrier();
        }
    }
    let t0 = std::time::Instant::now();
    batch.commit(true);
    t0.elapsed().as_secs_f64() * 1e6 / ITERS as f64
}

#[test]
#[ignore = "measurement probe: run with --ignored --nocapture"]
fn qmv_vs_qmm_crossover_on_this_gpu() {
    let Some(di) = detect_device() else {
        eprintln!("skipping: no Metal device");
        return;
    };
    let device = di.device;
    println!(
        "device: {} ({:?}), 4-bit gs{GS}, bf16 act / f16 scales; µs per op, median of 7 interleaved batches of {ITERS}",
        device.name(),
        di.profile.generation
    );
    let shapes: &[(&str, &str, usize, usize)] = &[
        ("qwen2.5-7b", "qkv", 4608, 3584),
        ("qwen2.5-7b", "o", 3584, 3584),
        ("qwen2.5-7b", "gate+up", 37888, 3584),
        ("qwen2.5-7b", "down", 3584, 18944),
        ("granite-2b", "qkv", 3072, 2048),
        ("granite-2b", "o", 2048, 2048),
        ("granite-2b", "gate+up", 16384, 2048),
        ("granite-2b", "down", 2048, 8192),
        ("gemma-26b", "q", 4096, 2816),
        ("gemma-26b", "kv", 2048, 2816),
        ("gemma-26b", "o", 2816, 4096),
        ("gemma-26b", "mlp gate|up", 2112, 2816),
        ("gemma-26b", "mlp down", 2816, 2112),
    ];
    let ms: &[usize] = &[8, 10, 12, 13, 14, 15, 16, 18, 24, 32];
    println!(
        "{:<11} {:<12} {:>6} {:>6} {:>3} {:>8} {:>8} {:>8} {:>6} {:>7} {:>9}",
        "model", "matrix", "N", "K", "M", "fold", "wide", "qmm_t", "splitk", "qmm/fold", "qmm/best"
    );
    let median = |mut v: Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    };
    for &(model, mat, n, k) in shapes {
        let w_bytes = n * k / 2;
        let sb_bytes = n * (k / GS) * 2;
        let copies = (ROTATE_BYTES / (w_bytes + 2 * sb_bytes)).clamp(2, 64);
        let mats: Vec<Mat> = (0..copies)
            .map(|c| {
                let m = Mat {
                    w: shared_zeroed(&device, w_bytes),
                    s: shared_zeroed(&device, sb_bytes),
                    b: shared_zeroed(&device, sb_bytes),
                };
                fill(&m.w, c as u8);
                fill(&m.s, 1);
                fill(&m.b, 2);
                m
            })
            .collect();
        let max_m = *ms.iter().max().unwrap();
        let x = shared_zeroed(&device, max_m * k * 2);
        fill(&x, 3);
        let y = shared_zeroed(&device, max_m * n * 2);
        let scratch = shared_zeroed(&device, 64 * max_m * n * 2);

        for &m in ms {
            let qmv = |wide_ok: bool| {
                let kernel = pick_qmv_kernel_wide(n as u32, k as u32, 4, m as u32, wide_ok);
                let name =
                    qmv_kernel_name(kernel, DequantDtype::Bf16, ScaleDtype::F16, GS as u32, 4, false);
                let mut c = vec![ConstantValue::int(0, k as i32), ConstantValue::int(1, n as i32)];
                if matches!(kernel, scratchy_target_metal::quantized::QmvKernel::Wide { .. }) {
                    c.push(ConstantValue::int(7, m as i32));
                }
                let pso = baked_pipeline(&device, "quantized_qmv", &name, c).expect("qmv pipeline");
                let (g, t) = qmv_dispatch_shape(kernel, m as u32, n as u32, 1);
                Path { pso, grid: sz(g), tg: sz(t), to_scratch: false, reduce: None }
            };
            let qmm = |kernel: QmmTKernel| {
                let aligned = (n as u32).is_multiple_of(32);
                let name =
                    qmm_t_kernel_name(kernel, DequantDtype::Bf16, ScaleDtype::F16, GS as u32, 4, aligned);
                let mut c = vec![
                    ConstantValue::int(0, k as i32),
                    ConstantValue::int(1, n as i32),
                    ConstantValue::int(2, m as i32),
                ];
                let mut reduce = None;
                if let QmmTKernel::SplitK { split_k, k_partition_size } = kernel {
                    c.push(ConstantValue::int(3, k_partition_size as i32));
                    let rc = vec![
                        ConstantValue::uint(0, m as u32),
                        ConstantValue::uint(1, n as u32),
                        ConstantValue::uint(2, split_k),
                    ];
                    let r = baked_pipeline(
                        &device,
                        "quantized_splitk_reduce",
                        splitk_reduce_kernel_static_name(DequantDtype::Bf16),
                        rc,
                    )
                    .expect("reduce pipeline");
                    let nt = (m * n) as u32;
                    reduce = Some((r, sz((nt.div_ceil(256), 1, 1)), sz((256, 1, 1))));
                }
                let pso = baked_pipeline(&device, "quantized_qmm", &name, c).expect("qmm pipeline");
                let (g, t) = qmm_t_dispatch_shape(kernel, m as u32, n as u32, 1);
                let to_scratch = reduce.is_some();
                Path { pso, grid: sz(g), tg: sz(t), to_scratch, reduce }
            };
            let picked = pick_qmm_t_kernel(m as u32, n as u32, k as u32, 1, GS as u32, false);
            let paths = [qmv(false), qmv(true), qmm(picked)];
            for p in &paths {
                time(&device, p, &mats, &x, &y, &scratch);
            }
            let mut samples = [vec![], vec![], vec![]];
            for _ in 0..7 {
                for (i, p) in paths.iter().enumerate() {
                    samples[i].push(time(&device, p, &mats, &x, &y, &scratch));
                }
            }
            let [fold, wide, mm] = samples.map(median);
            let sk = match picked {
                QmmTKernel::SplitK { split_k, .. } => split_k,
                _ => 1,
            };
            println!(
                "{model:<11} {mat:<12} {n:>6} {k:>6} {m:>3} {fold:>8.1} {wide:>8.1} {mm:>8.1} {sk:>6} {:>7.2} {:>9.2}",
                mm / fold,
                mm / fold.min(wide)
            );
        }
    }
}
