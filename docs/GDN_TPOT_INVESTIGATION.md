# qwen3.6 / GDN TPOT gap: investigation plan

Status: plan, not started. Nothing here is a finding until a step below
measures it.

## The question

qwen3.6 (GDN hybrid) decodes slower than oMLX on Apple silicon. The gap may be
two separate problems:

1. **Speculation cost.** On the M3 Pro, DFlash2 looks more expensive than MTP.
2. **Decode stalls under prefill.** While another request prefills, scratchy's
   decode stalls longer than oMLX's.

Every measurement records one of three speculation states: **off**, **MTP**,
**DFlash2**. A number without its state can't be compared.

## Evidence so far

| observation | source |
|---|---|
| 1 user TPOT, scratchy vs oMLX: qwen3.6 8.7 vs 5.8 ms; Nemotron 5.4 vs 6.5; Granite 5.8 vs 6.6; gpt-oss 5.2 vs 5.1 | M4 Max run `940736b5` (PR #1133) |
| 4 users TPOT: qwen3.6 60.9 vs 37.2; Nemotron 55.9 vs 25.5; Granite 51.9 vs 27.5; gpt-oss 26.1 vs 27.0 | same |
| so at 1 user only qwen3.6 is an outlier; at 4 users the gap is general scheduling, not GDN-only | derived |
| qwen3.6 in that run used the default drafter (DFlash2, 7 drafts), which the run file doesn't record | serve defaults |
| DFlash2 on→off at 1 user: TPOT 8.5→5.1 ms | local A/B, M4 Max |
| qwen `warm_serving` TPOT regressed 9.95→12.41 ms (M3 Pro, `11091c9a`→`8d507bc1`) and 3.99→4.88 ms (M4 Max); other models flat | site data / unpublished M3 Pro run |
| that window contains DFlash2 (#1015, `69d31cb3b`) and the tape-typing chain #1083–#1106; not bisected | git log |
| smaller prefill pieces hurt when there are no decode-only steps | piece-size sweep |
| `kt512` vs `kt4096`: only `AffineGatherQmmT` gets worse | per-kernel times |
| pad 64→32: no change | local A/B |
| the only in-repo MTP vs DFlash2 comparison (M5 Max, `69d31cb3b` message) has DFlash2 ≥ MTP; no M3 Pro artifacts exist | git log |

### Bench semantics to keep in mind

- `--timed-answers` uses `max_tokens=64` (`RAG_TIMED_TOKENS`) with
  `ignore_eos: true`: free generation, not padding. Accuracy is null on timed
  cells. oMLX may still stop at EOS, so check output token counts match.
- TPOT is a per-request average; `p99_tpot_ms` is p99 *across requests*. For
  streaming stalls use ITL or `--save-detailed` chunk timings.
- DFlash2's `exclude_stop` only touches sampled lanes. At temp 0 it is inert,
  so it is not a cause.
- Spec counters (`spec_decode_num_drafts`, `_draft_tokens`,
  `_accepted_tokens`) are populated; accepted is inferred as `len - 1`. There
  are no draft or verify wall-clock counters.

## Hypotheses (ranked)

1. **Verify cost is mispriced for dense GDN.** `VerifyRows::of_target`
   (`crates/targets/metal/src/dflash2.rs`) verifies every row for dense targets
   and uses a budget only for MoE. `MetalStepTape::weight_bytes`
   (`crates/targets/metal/src/tape/step.rs`) doesn't price GDN state replay, so
   speculation can look cheaper than it is. MTP drafts 2, DFlash2 drafts 7;
   both verify 8 rows.
2. **No decode-only turns.** When prefill shares a step with decode, decode
   waits for the whole piece. oMLX bounds this
   (`_DECODE_STALL_TARGET_MS = 500`, `_DECODE_FAIR_SHARE = 0.5` in
   `omlx/scheduler.py`). This would explain the 4-user gap across all models.
3. **Expert matmul tile.** `affine_gather_qmm_t_kernel`
   (`crates/targets/metal/shaders/quantized_qmm.metal`, BM = 32) may be too
   big for small decode batches. 35B MoE only.
4. **GDN pipelined scan rows.** `GDN_PIPE_ROWS = 32`
   (`crates/targets/metal/src/tape/lowering.rs`) vs oMLX `_PIPE_DB = 16`; both
   use TB = 12. Only worth trying if step 1 shows meaningful GDN time.

## Steps

1. **Dense 27B, 1 user, off / MTP / DFlash2.** Dense GDN
   (`crates/models/arch/configs/qwen3-5/qwen3.6-27b.json`) removes MoE tiles as
   an explanation. Per state: TPOT, acceptance, and a per-kernel GPU breakdown
   (`SCRATCHY_METAL_KERNEL_TIME=1`) split into draft, verify, GDN, attention,
   matmul. Repeat on the 35B-A3B. Confirms or kills hypothesis 1.
2. **Two-request stall test, speculation off.** Request A decodes; request B
   arrives with a fresh 4096-token prompt. Budgets
   `--max-num-batched-tokens` 512 and 4096. Measure A's longest ITL gap and
   B's TTFT, scratchy vs oMLX.
3. **Decode-only-turn prototype** in `schedule()`
   (`crates/serving/scheduler/src/scheduler/core.rs`) modeled on oMLX's stall
   target and fair share. Rerun step 2.
4. **Tile experiments, one at a time:** expert matmul BM 32→16 (35B only),
   then `GDN_PIPE_ROWS` 32→16 if step 1 justifies it. Kernel tests in
   `crates/targets/metal/tests/gated_delta_test.rs` must still pass.
5. **Combine only standalone winners.** 2×2 of scheduler × kernel change,
   speculation off first, then MTP and DFlash2. Full bench cell at 1 and 4
   users.

Bench cell (new `--seed` per cell):

```bash
scr bench serve --dataset-name rag --rag-source musique \
  --chat-template-kwargs '{"enable_thinking":false}' --timed-answers \
  --output-len 64 --max-prompt-tokens 8192 --num-warmups 2
```

Server: `scr serve <model> --port <p> [--num-speculative-tokens 0]
[--max-num-batched-tokens N]`. Build from a fresh upstream `main`.

## Success criteria

- TPOT or stall improvement larger than run-to-run variation.
- TTFT, throughput, and memory reported alongside it.
- Correctness and accuracy gates unchanged.
- A trace that shows where the saved time came from.

## Open data requests

- M3 Pro MTP vs DFlash2 numbers or artifacts (none exist in the repo).
- Exact HF model ID for the dense 27B.
- Whether to record the drafter per cell in site data, or turn speculation
  off in timed cells.
