# Plan: nemotron-3-super streams each reply in one chunk (#937)

Branch `fix/nemotron-super-streaming`, from upstream `main` `acc4046b`. M4 Max, macOS 27.2.

**Scope:** prompts up to 8K tokens only. Every grid in this plan uses
`--scale-grid-input 128,1024,4096,8192`; the 32K cells (which failed on their own, 0 completed)
are out of scope.

## What we know

- On `e63c6f8a`, 212/216 grid and 20/20 warm-serving requests were unstreamed; 8 of 12 completed
  cells have no TTFT or TPOT.
- The server log shows normal per-token decode (`ttft_ms≈309`, `avg_itl_ms≈17`), so the tokens are
  made step by step and held back between the engine and the SSE stream.
- The bench (`chunk_text` in `crates/benches/src/serve.rs`) times only chunks with non-empty text,
  and the chat endpoint drops empty content (`server.rs`). Sending empty-text chunks fixes nothing.
- Lead, unconfirmed: `IncrementalDetokenizer` (`crates/serving/api/src/detokenizer.rs`) holds back
  text that renders as U+FFFD until its bytes complete.

## Pre-flight

AC power, Ollama quit, port 8751 free. Long runs go in the background; wait on the exit line.

## Steps

### 1. Reproduce with single requests (~15 min GPU)

```bash
cargo build --release -p scratchy-cli \
  --features metal,serve,bench,model/nemotron-3-super-120b-a12b,quant/mlx-affine-b4-g64-qembed
scr serve mlx-community/NVIDIA-Nemotron-3-Super-120B-A12B-OptiQ-2bit --port 8751
```

- The bench's own random prompt, at both ends of the scope:

  ```bash
  for len in 128 8192; do
    scr bench serve --base-url http://127.0.0.1:8751 \
      --model mlx-community/NVIDIA-Nemotron-3-Super-120B-A12B-OptiQ-2bit \
      --num-prompts 1 --input-len $len --output-len 64 --max-concurrency 1 \
      --temperature 0 --seed 0 --save-detailed --output-json /tmp/perf-nemo/one-$len.json
  done
  ```

  `chunks` in the JSON is how many chunks carried text.
- A natural English prompt with `curl -N` on `/v1/completions`, `"stream": true`,
  `"ignore_eos": true`, `"max_tokens": 64`. Record each chunk's arrival time and text.

**Read:** the natural prompt streams and the random one doesn't → held-back byte fragments.
Neither streams → the stream path itself, not the tokenizer.

### 0. Nano baseline on this Mac (download in background during step 1, ~20 min GPU)

nemotron-3-nano isn't cached here (~18 GB). Rule out the machine and the commit:

```bash
./scripts/bench_metal_matrix.sh --fail-fast --unpinned --models nemotron-3-nano-30b-a3b \
  --scenarios cold,warm --scale-axes grid --scale-grid-input 128,1024,4096,8192 \
  --scale-grid-output 64 --scale-grid-conc 1 --scale-grid-users-output "" \
  --out-dir /tmp/perf-nano
```

**Read:** nano unstreamed here too → the Mac or commit, not the super model.

### 2. Look at the tokens (no GPU)

- Get step 1's generated token ids. `warn_if_empty_text` logs them only when the whole text is
  empty, so this may need `logprobs` or a temporary, uncommitted debug line.
- Decode them one by one with the super model's `tokenizer.json`; look for U+FFFD and partial
  byte runs.
- Compare its decoder and byte-fallback settings with nano's.

### 3. Find the hold-back

- Trace `IncrementalDetokenizer::update` → `decode_next` / `get_next_output_text` → the
  completions stream in `server.rs`.
- Reproduce it as a failing unit test in `detokenizer.rs` `mod tests`, beside
  `test_streaming_decode_multibyte_utf8`, using step 2's ids. No model, no GPU.

### 4. Decide the fix (needs sign-off)

- **(a)** Emit complete text sooner, if step 3 shows text held back that didn't need to be.
- **(b)** If the held bytes really never form valid text, keep the behavior: document it in #937
  and beside `is_unstreamed`, as the bench does for mlx_lm.server. The fault is then the model's
  output, not the stream.

### 5. Measure the fix

```bash
cargo test -p scratchy-serving-api --lib   # read the whole output, not the last line
./scripts/bench_metal_matrix.sh --fail-fast --unpinned --models nemotron-3-super-120b-a12b \
  --scenarios cold,warm --scale-axes grid --scale-grid-input 128,1024,4096,8192 \
  --scale-grid-output 64 --scale-grid-conc 1,4,8,16 \
  --out-dir /tmp/perf-nemo-fix
```

**Pass:** every cell has `unstreamed_requests` 0 and both `median_ttft_ms` and `median_tpot_ms`.

### 6. No regressions

- Rerun step 0's nano grid; it still streams.
- Leave `chunk_text`'s empty-chunk skip alone (it guards against oMLX's keepalive chunks).

## Out of scope

- Prompts above 8K, including the 32K cells.
- The 1.19 ms TPOT at 128x64 @ 4 (one request); recheck only if it survives the fix.
- Scheduler and Metal kernels: the server log already shows normal step timing.

## Do not

- Remove or parallelize `pipeline_build_turn` (#288, #507).
- Add env-var toggles or `#[allow]`, or weaken a test (CLAUDE.md).
