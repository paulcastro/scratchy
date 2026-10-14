# Plan: vision-language-action (VLA) models in Scratchy

Status: plan, nothing implemented. Branch `scratchy-omni`.

A VLA model takes camera images, a language instruction and (usually) the
robot's state, and returns a chunk of robot actions. Targets, in order of
how much new machinery each needs:

| Model | Backbone | Action output |
|---|---|---|
| OpenVLA-7B | Prismatic (DINOv2 + SigLIP) + Llama-2-7B | 7 discretized tokens (256 bins), de-tokenized on the host |
| pi0 / pi0.5 | PaliGemma (SigLIP + Gemma 2B) | flow-matching action expert, ~10 denoising steps |
| SmolVLA | SmolVLM2 (SigLIP + SmolLM2) | flow-matching expert, alternating cross/self-attention |
| GR00T N1.5 | Eagle VLM | DiT action head, cross-attention to backbone features |

## What already exists

- **Vision towers** as `@vision_forward` carriers (`qwen2-vl`, `qwen2-5-vl`,
  `qwen3-5-vl`, `gemma3-mm` (SigLIP), `locateanything` (MoonViT)), host glue in
  `crates/models/vision/`, embedding splice into the text stream
  (`SpliceMmEmbeds` → metal `MmEmbedSplice`, `crates/targets/metal/src/tape/lowering.rs`).
- **Backbones**: Llama-2-7B (OpenVLA) and SmolLM2 (SmolVLA) are already
  compiled under `configs/llama/`.
- **Bidirectional attention**: the 3-arg `attention(q, k, v)` (`dsl/modernbert.py`)
  and `varlen_attention` (vision towers).
- **A second model reading a target's KV without writing its own**:
  `shared_attention` / `shared_sliding_attention` (`dsl/gemma4-assistant.py`),
  and the head mechanism around it: `checkpoint_of`, the `target_hidden` extern,
  lent weights (`crates/compiler/src/heads.rs`, "Multi-token-prediction heads"
  in [`MODELS.md`](MODELS.md)). An action expert attending the VLM prefix fits
  the same mould.
- **Output paths that skip sampling**:
  - the pooling runner (`--runner pooling`, `crates/serving/worker/src/gpu_worker.rs`
    ~6843–6905), which returns the terminal buffer as floats;
  - `allowed_token_ids` / the grammar mask, which restrict sampling to a token
    set (`crates/core/common/src/sampling.rs`, `crates/targets/metal/src/grammar_mask.rs`,
    `crates/targets/cuda/src/logits_processor.rs`).

## What is missing

- **Robot inputs**: no state/proprioception vector, no named multi-camera views;
  images only arrive as `data:` URIs in chat content
  (`crates/serving/api/src/engine.rs` `extract_images_from_messages`).
  `ImageData` (`crates/core/common/src/multimodal.rs`) is 3-channel, one frame.
- **Images under chunked prefill**: the vision tower runs only on the first
  prefill chunk (`gpu_worker.rs` `run_mm_vision_forward_metal`, `tokens_before == 0`).
  There is no encoder cache; the scheduler's `encoder_cache_size`,
  `max_num_encoder_input_tokens` and `scheduled_encoder_inputs` exist but are
  unused.
- **Continuous outputs**: no action response type, no denoising loop.
- **Ops**: attention that reads the prefix KV and is bidirectional (or
  block-causal) within its own block; sinusoidal timestep embedding; adaptive
  RMSNorm (pi0.5); cross-attention (SmolVLA, GR00T).
- **Spyre** has no vision path at all.

## Design

**The action expert is a head arch**, modelled on MTP heads:

- its own `dsl/<arch>.py` and `configs/<arch>/arch.json`, with
  `checkpoint_of: [<vlm-arch>]` and the prefix where its tensors sit in the
  VLM's checkpoint;
- it attends the VLM's KV cache through a new prefix-attention op;
- its per-call inputs are new externs: `noisy_actions`, `timestep`, `state`.

**The worker runs the denoising loop on the host.** Each Euler step
(10 for pi0, 4 for GR00T) is one fixed-shape call of the head; the noisy
actions stay on the device between steps. The DSL gains ops, not control flow.

**Shapes stay compile-time constants.** `action_horizon`, `action_dim` and the
step count come from the config; the head's bucket ladder is
`batch × action_horizon`.

## Phases

### Phase 0: scope and goldens

1. Pin target checkpoints: OpenVLA-7B, pi0 / pi0.5 (openpi or LeRobot ports),
   SmolVLA, GR00T N1.5.
2. Generate goldens from the reference implementations (`openvla`, openpi,
   LeRobot): fixed image + instruction + state + seeded noise → actions.
   They live with the existing goldens in `crates/e2e/testdata/`.
3. Record the head-arch decision as an ADR (`docs/adr/`) once agreed.

### Phase 1: OpenVLA (actions as tokens)

4. `prismatic` `@vision_forward` carrier: DINOv2 and SigLIP side by side at
   224 px, features concatenated, then a 3-layer MLP projector. Needs a learned
   position embedding (`pos_embed` exists), LayerScale (a `mul` by a learned
   vector), and two input normalizations in one processor.
5. OpenVLA's `config.json` under the llama arch, with `arch.json` /
   `.overrides.json` for the decoder prefix and padded vocabulary.
6. Processor: OpenVLA's prompt template and placeholder policy.
7. Action decoding: greedy, exactly `action_dim` tokens, `allowed_token_ids` =
   the 256 bin tokens; map tokens to bin centres and un-normalize with the
   checkpoint's `norm_stats[unnorm_key]` on the host.
8. Golden + correctness test on metal and cuda.

### Phase 2: robot-observation infrastructure

9. API: `/v1/actions` taking
   `{images: {<camera>: …}, state: [f32], instruction, unnorm_key, seed}` and
   returning `actions: [[f32; action_dim]; horizon]`. Optionally a WebSocket
   mode compatible with openpi / LeRobot policy servers.
10. Core types: named camera views and `state: Option<Vec<f32>>` on
    `MultimodalData`; hash the state into the prefix-cache key
    (`crates/serving/scheduler/src/scheduler/core.rs` `build_mm_extras`).
11. Encoder vs chunked prefill: keep image embeddings until the request
    finishes (wire the existing encoder-cache fields), or force the image
    prefix into one chunk.
12. Request kind `action`, alongside `is_pooling`: prefill, then the action
    head, then finish, with no sampling loop.

### Phase 3: continuous action heads (compiler + targets)

13. New ops, each one registry row plus one emitter arm per target (metal,
    cuda), per the invariants in [`CLAUDE.md`](../CLAUDE.md):
    - `prefix_attention(q, k, v, kv_cache, block_table)`: prefix KV plus the
      action block, bidirectional or block-causal within the block; extends
      `shared_attention`;
    - `timestep_embed(timestep)`: sinusoidal (could start as a host-built extern);
    - `ada_rmsnorm(x, cond, w)` for pi0.5;
    - `cross_attention(q, ctx_k, ctx_v)` for SmolVLA and GR00T.
14. Externs `noisy_actions`, `timestep`, `state` in `ExternKind`
    (`crates/compiler/macros/src/classified.rs`), shape-inferred from
    `action_horizon` / `action_dim`.
15. `ActionHeadRegistration` next to `HeadRegistration`
    (`crates/compiler/src/heads.rs`): VLM arches it attaches to, weight prefix,
    horizon, action dim, step count, solver. Registered via `inventory::submit!`.
16. Worker loop: seeded Gaussian noise; per step, velocity from the head, then
    `x += dt·v`; un-normalize and return. Batch all requests' action blocks
    into one bucket.

### Phase 4: pi0 / pi0.5

17. PaliGemma backbone: SigLIP at 224 px, no pooling, linear projector (close
    to `dsl/gemma3-mm.py`); Gemma-1 2B decoder (no `gemma` v1 arch dir exists;
    see whether `gemma2` minus softcap and alternating layers covers it).
    Prefix-LM masking: image and text tokens attend each other bidirectionally;
    first check what `gemma3-mm` does for its image tokens today.
18. pi0 action expert carrier (Gemma 300M): attention over prefix KV plus
    `[state, action]` tokens, block-causal; time-conditioned action MLP.
19. pi0.5: adaptive-RMSNorm time conditioning; discretized state tokens in the
    prompt (processor change).

### Phase 5: SmolVLA, then GR00T

20. SmolVLA: SmolVLM2 vision tower with pixel-shuffle connector on the existing
    SmolLM2 decoder; run only the first `num_vlm_layers` (bound override in
    `arch.json`); action expert alternating cross- and self-attention.
21. GR00T N1.5: Eagle VLM backbone; DiT action head cross-attending backbone
    features (reuses `cross_attention`); per-embodiment state/action encoders.

### Phase 6: performance, targets, docs

22. Benchmark latency per action chunk on metal and cuda, following
    [`BENCHMARKING.md`](BENCHMARKING.md).
23. Spyre: out of scope until it has a vision prelude.
24. Docs: a "VLA / action heads" section in [`MODELS.md`](MODELS.md) next to
    the MTP-heads section; `model/<stem>` features per VLA; a
    `scr serve … --runner action` example.

## Risks to check early

- **Prefix-LM masking in the decoder** (PaliGemma, OFT) is a decoder-side
  attention variant, not just a head op; likely the largest change in
  `impl_lib.rs` / `codegen.rs`.
- **pi0's mixture-of-experts attention** (shared attention, separate weights
  per token group) may force a joint forward instead of a head that only reads
  prefix KV. In the original pi0 the prefix sees nothing of the suffix, so
  reading prefix KV should be exact; confirm against openpi.
- **Weights**: openpi ships JAX/Orbax; needs a conversion path or the LeRobot
  safetensors ports.
- **Numerics**: flow-matching output depends on noise, so goldens fix the seed
  and pass the noise in.

## Open questions

1. First model: OpenVLA (cheapest, Phase 1) or pi0 / SmolVLA (the real design)?
2. Targets: metal first, or metal and cuda together?
3. API: OpenAI-style endpoint, openpi/LeRobot WebSocket compatibility, or both?
