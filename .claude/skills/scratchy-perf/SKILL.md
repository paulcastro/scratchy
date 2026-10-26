---
name: scratchy-perf
description: Inner loop for Metal performance work on scratchy (scheduler, Metal worker, memory, startup). Use when diagnosing or fixing a perf gap vs mlx-lm, writing a scheduler perf test, measuring one benchmark cell, or reading a bench_metal_matrix.sh result JSON. For full published matrix runs use metal-bench instead.
---

# Scratchy perf work: find, change, measure one cell, compare

Full matrix rounds and publishing are `metal-bench`'s job. This skill is the
loop around one change. Cite code by symbol name; the line numbers below are
hints from upstream `e63c6f8a` and drift.

## Code map

| Lever | Where |
|---|---|
| Step scheduling | `Scheduler::schedule()` in `crates/serving/scheduler/src/scheduler/core.rs` (~3281). ONE `token_budget` (= `max_num_scheduled_tokens`) is spent first on RUNNING requests (Phase 1, decodes and continuing prefill chunks), then on WAITING ones (Phase 2). No decode priority: a running request's long prefill chunk can eat the step. |
| Scheduler knobs | `crates/core/config/src/scheduler.rs`: `max_num_batched_tokens`, `long_prefill_token_threshold` (0 = no cap), `max_num_partial_prefills` / `max_long_partial_prefills` (declared, never read anywhere). |
| Metal budget | `crates/serving/api/src/init.rs` (~1620-1666): on Metal `max_num_batched_tokens` = the largest affordable prefill bucket; sliding-window models capped at `SWA_PREFILL_CHUNK_CAP` = 2048; `enable_chunked_prefill: true` is hard-wired. |
| CLI flags | `crates/cli/scr/src/args.rs`: `--max-num-batched-tokens`, `--max-num-seqs`. No flag for `long_prefill_token_threshold`. |
| Metal step | `crates/serving/worker/src/gpu_worker.rs`: `execute_model` (~6515) runs the normal step through `self.forward_argmax_then(...)` (~7706); the `forward_argmax_blocking` call (~7660) is the **speculative-verify** path, not the normal step. Bucket choice `metal_select_bucket`; KV budget `determine_available_memory` (~6145). |
| Attention | m>1 rows go to the paged prefill FA-2 kernel (`AttentionPrefillPaged`, `crates/targets/metal/compiler/src/steps_from_tape.rs`). |
| Weights / RSS | `register_mmap` in `crates/targets/metal/src/metal_allocator.rs` (~989): sidecar hit = no-copy; miss = `register_mmap_copy_path` (aligned copy). |
| KV (TurboQuant) | `build_tq_provision` in `crates/targets/metal/src/turboquant.rs`: stores are already placement-sparse. |
| Pipeline builds | `pipeline_build_turn()` in `crates/targets/metal/src/specialized_pipeline_cache.rs`: a global lock. |

## Fast dev loop

- Scheduler logic needs no GPU and no model:
  `cargo test -p scratchy-serving-scheduler --lib <test_name>` (about 12 s warm).
  Without `--lib` cargo also runs other targets, and the LAST line printed is
  `running 0 tests` from one of them; read the whole output, not the tail.
- New scheduler tests go in `mod tests` at the bottom of `core.rs`, beside
  `test_long_prefill_threshold` / `test_token_budget_limit`. Pattern:
  `SchedulerConfig { max_num_batched_tokens, max_num_seqs, enable_chunked_prefill: true, ..Default::default() }`,
  `Scheduler::with_simple_blocks(&cfg, 8192, 100, 16)`, `make_request(id, prompt_len)`,
  `sched.schedule().num_scheduled_tokens[id]`.
- Building the server: scope to ONE model, never `model/all`:
  `cargo build --release -p scratchy-cli --features metal,serve,model/<stem>`.
- House rules (CLAUDE.md): no new env-var toggles, no `#[allow]`, never weaken a test.

## Measure one cell

`bench_metal_matrix.sh` on upstream main knows only the stems in its
`MODELS_ALL`; any other stem prints `unknown model:` and exits 2. The old M4
Max runs used `granite-3.3-2b-instruct` and `qwen2.5-7b`, which are NOT in
main's list: restore their rows from `git show 2683d8c3:scripts/bench_metal_matrix.sh`
(lines 59 and 62) in a local commit that never goes into a PR.

One grid cell set vs mlx-lm (`mlx_lm` is the engine key):

```bash
source ~/.venvs/mlx/bin/activate && caffeinate -dims ./scripts/bench_metal_matrix.sh \
  --fail-fast --unpinned --models <stem> --engines mlx_lm --scenarios cold,warm --reps 3 \
  --scale-axes grid --scale-grid-input 4096 --scale-grid-output 16,128 \
  --scale-grid-conc 8 --scale-grid-users-output "" \
  --out-dir /tmp/perf-<tag> 2>&1 | tee /tmp/perf-<tag>.log; echo "exit ${PIPESTATUS[0]}"
```

- Defaults are NOT the old grid: outputs default to 64 tokens only; `--full`
  adds frozen + 3 reps + oMLX engines. Name the cells you want.
- Pre-flight: AC power, Ollama quit, port 8751 free. Frozen needs passwordless
  `sudo purge`; without it use `--scenarios cold,warm` and say frozen is unmeasured.
- Takes minutes per cell and hours for a matrix: run in the background, wait on
  the exit line, never poll in a sleep loop.

## Read the result JSON

```
.repo.sha  .repo.dirty  .machine.power ("Now drawing from 'AC Power'")
.models[] by .stem
  .scaling[]          scratchy cells   } axis "grid"|"conc", rung "4096x16" (grid) or 8 (conc),
  .scaling_mlx_lm[]   mlx-lm cells     } median_tpot_ms, p99_tpot_ms, median_ttft_ms,
  .scaling_ollama[]   ollama cells     } output_throughput, unstreamed_requests
  .cache_ladder[] / .cache_ladder_mlx_lm[]  scenario frozen|cold|warm, rep, t_ready_s, peak_rss_mib, ttft_exec_s
  .warm_serving       conc-1 serving
```

- Commit is `.repo.sha` (there is no `repo.commit`); power is a sentence, match `AC Power`.
- Grid cells in older files carry no `conc` field: they ran at the base conc 8.
- Example: `jq '.models[]|select(.stem=="qwen2.5-7b")|.scaling[]|select(.axis=="grid" and .rung=="4096x16")|.median_tpot_ms' <json>`.
- Drop cells with `unstreamed_requests > 0` (most ollama gemma cells).
- Lower TPOT/TTFT is better; higher throughput is better. A ratio target like
  "0.95x mlx" means TPOT <= mlx/0.95, not TPOT >= 0.95*mlx.
- A difference smaller than the spread across reps is noise.
- Published M4 Max runs: `site/data/metal/apple-m4-max-*.json` (latest `2683d8c3`).

## Do not

- Remove or parallelize `pipeline_build_turn`: Apple's GPU compiler corrupts its heap under concurrent builds (#288, #507).
- Drop the zeroing of TurboQuant norms/scratch to save memory: a stale norm turns into Inf/NaN logits.
- Change the default KV dtype to "match" mlx-lm: scratchy ships TurboQuant KV, mlx-lm runs fp16; report the asymmetry instead.
- Trust ollama cells for decode comparisons: it ignores `ignore_eos`.
- Call the scheduler crate `scratchy-scheduler`: it is `scratchy-serving-scheduler`.
