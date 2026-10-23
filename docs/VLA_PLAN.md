# Plan: vision-language-action (VLA) models in Scratchy

Today Scratchy looks at pictures and words and answers with words.
A robot needs it to look at camera pictures, hear "pick up the cup", and
answer with *arm movements* (a list of numbers). This plan teaches Scratchy
that last trick.

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

Before building, count the LEGO bricks already in the box. Most of
what a robot model needs (eyes, a language brain, a helper that reads another
model's memory) is already here, so we only build the missing pieces.

- **Vision towers (the model's eyes).** A language model only understands
  words. A vision tower is a smaller network that looks at a picture, cuts it
  into little squares, and turns each square into a "picture word" the
  language model can read. Those picture words are then pasted into the
  sentence at the spot where the image was ("splicing"). Scratchy already has
  several sets of eyes, including SigLIP, the same eyes pi0 and SmolVLA use.
  In the code: `@vision_forward` carriers (`qwen2-vl`, `qwen2-5-vl`,
  `qwen3-5-vl`, `gemma3-mm` (SigLIP), `locateanything` (MoonViT)), host glue
  in `crates/models/vision/`, the splice `SpliceMmEmbeds` → metal
  `MmEmbedSplice` (`crates/targets/metal/src/tape/lowering.rs`).
- **Backbones (the language brain).** Every robot model is built on top of an
  ordinary language model that does the thinking: it reads the picture words
  and the instruction and works out what is going on. That base model is the
  backbone. OpenVLA's (Llama-2-7B) and SmolVLA's (SmolLM2) already run in
  Scratchy, so for those two the brain is done.
  In the code: `configs/llama/`.
- **Bidirectional attention (reading in both directions).** "Attention" is how
  each word decides which other words matter to it. A chat model reads left
  to right: each word may only look at the words before it, because the later
  ones haven't been written yet. Bidirectional attention lets every word look
  at every other word, before and after, like seeing a whole page at once.
  Scratchy can already do this, but only in places that don't save notes for
  later (an embedding model and the eyes), which is why the robot version is
  listed as missing.
  In the code: the 3-arg `attention(q, k, v)` (`dsl/modernbert.py`) and
  `varlen_attention` (vision towers).
- **A helper model that reads the big model's notes.** While a model reads,
  it writes notes about every word so it doesn't have to re-read them later;
  those notes are the KV cache. Scratchy already runs small helper models
  ("heads") that sit beside a big model and read its notes instead of making
  their own; today they are used to guess the next few words ahead of time to
  speed up chat. A robot's action expert is the same kind of helper: it reads
  the big model's notes about the scene and works out the arm motion. The
  machinery for loading such a helper from the big model's files is also
  there.
  In the code: `shared_attention` / `shared_sliding_attention`
  (`dsl/gemma4-assistant.py`), `checkpoint_of`, the `target_hidden` extern,
  lent weights (`crates/compiler/src/heads.rs`, "Multi-token-prediction heads"
  in [`MODELS.md`](MODELS.md)).
- **Ways to answer without picking words.** Normally a model ends each step by
  "sampling": it scores every possible next word and picks one of the likely
  ones. A robot wants numbers, not words, and Scratchy already has two ways
  around normal word picking:
  - **Raw-number output (the pooling runner).** Instead of choosing a word, it
    hands back the model's final numbers as they are. Arm movements are just
    numbers, so this is the closest thing to an action answer today.
    In the code: `--runner pooling`, `crates/serving/worker/src/gpu_worker.rs`.
  - **An allowed-words list.** Scratchy can forbid every word except a chosen
    few. OpenVLA "says" each arm movement as one of 256 special words, so
    limiting it to those words guarantees it can only answer with movements.
    In the code: `allowed_token_ids` / the grammar mask
    (`crates/core/common/src/sampling.rs`, `crates/targets/metal/src/grammar_mask.rs`,
    `crates/targets/cuda/src/logits_processor.rs`).

## What is missing

These are the bricks we don't have yet. The biggest: robot models
read their whole picture-plus-instruction at once (looking both ways), but
Scratchy only knows how to read left to right. Read the wrong way, the robot
gets subtly wrong numbers and nobody notices until the arm misses the cup.

**New** = nothing like it exists in Scratchy today. **Extend** = something
close exists and is changed or generalized. **Reuse** = exists as is; only
needs to be switched on.

| Area | Scratchy today | Change needed | Status |
|---|---|---|---|
| Prefix-LM attention | Decoder attention is causal only; bidirectional `attention(q, k, v)` exists only in modernbert and writes no KV; no prefix mask | `prefix_lm_attention`: bidirectional over the prefix, causal after it, writes the KV cache | Extend |
| Action-expert attention | `shared_attention` reads the target's KV of its last layer of the same class; writes none of its own | `prefix_attention`: layer *i* reads VLM layer *i*'s prefix KV plus its own suffix K/V, block-causal by a compile-time mask | Extend |
| Adaptive RMSNorm (pi0.5) | Plain `rmsnorm` only | `ada_rmsnorm(x, cond, w)` op | New |
| Cross-attention (GR00T) | None | `cross_attention(q, ctx_k, ctx_v)` op; only if SmolVLA's layers are not `prefix_attention` | New |
| Timestep embedding | None | Precomputed table of the N fixed step embeddings; no op | New |
| Action externs | `ExternKind` covers tokens, positions, KV, pixels, ...; `Pixels` has a materialize pass (`vision_lowering.rs`) | `noisy_actions`, `timestep`, `state` externs, their `extern_shape` entries and a materialize pass | Extend |
| Action head | `HeadRegistration` is built for spec-decode drafters; `mtp-heads` feature | `ActionHeadRegistration` sharing the checkpoint-prefix loader; `action-heads` feature; dims from `.overrides.json` | New |
| Denoising loop | None | Worker runs N head calls; the head outputs `x_next = x + dt·v` on the device | New |
| Action output | Pooling runner returns the terminal buffer as floats; `allowed_token_ids` restricts sampling | Action response type `[[f32; action_dim]; horizon]` | Extend |
| Action API | Chat / completions endpoints only | `/v1/actions`, then an openpi-compatible WebSocket | New |
| Robot state | No state / proprioception input | `state: Option<Vec<f32>>` on `MultimodalData` | New |
| Cameras | `ImageData` is one unnamed 3-channel frame; images only as `data:` URIs in chat | Named camera views, absent-camera mask, raw uint8 HWC input | Extend |
| Normalization | None | Host normalizer per checkpoint: state in, actions out (mean/std, quantiles, delta vs absolute) | New |
| Chunked prefill | Vision tower runs on the first chunk only; encoder-cache config fields unused | Action requests prefill their whole prefix in one chunk; encoder cache stays unwired | Extend |
| Prefix cache | Images hashed into per-block cache keys | Mark action requests `volatile` (existing flag, already skips caching) | Reuse |
| VLA vision towers | SigLIP (`gemma3-mm`), Qwen-VL, MoonViT | DINOv2 + SigLIP fused tower (OpenVLA), PaliGemma's SigLIP config | New (DINOv2), Extend (SigLIP) |
| VLA backbones | Llama-2-7B and SmolLM2 compiled | Gemma-1 2B for PaliGemma (pi0); Eagle (GR00T) | New |
| Spyre | No vision path | Out of scope | New (deferred) |

- **Prefix-LM attention in the decoder**: pi0, pi0.5 and SmolVLA attend their
  image + text prefix bidirectionally, and the action expert reads that
  prefix's KV, so without it every continuous-head model is silently wrong.
  Today's bidirectional `attention(q, k, v)` (modernbert) writes no KV cache;
  nothing in the decoder path has a prefix mask (`token_type_ids`).
  Robot models read the pictures and instruction all at once, looking both
  ways, then save notes for the action expert. Scratchy's language brain only
  reads left to right, so the notes come out subtly wrong.
- **Robot inputs**: no state/proprioception vector, no named multi-camera views;
  images only arrive as `data:` URIs in chat content
  (`crates/serving/api/src/engine.rs` `extract_images_from_messages`).
  `ImageData` (`crates/core/common/src/multimodal.rs`) is 3-channel, one frame.
  A robot sends several named cameras ("wrist", "top") plus where its joints
  are right now. Today Scratchy only accepts pictures pasted into a chat
  message and has nowhere to put the joint positions.
- **Images under chunked prefill**: the vision tower runs only on the first
  prefill chunk (`gpu_worker.rs` `run_mm_vision_forward_metal`, `tokens_before == 0`).
  There is no encoder cache; the scheduler's `encoder_cache_size`,
  `max_num_encoder_input_tokens` and `scheduled_encoder_inputs` exist but are
  unused.
  Long inputs get read in pieces, and the eyes only look at the first piece.
  Fine for chat, but robot models must read their input in one piece anyway.
- **Continuous outputs**: no action response type, no denoising loop.
  Robot models answer with smooth numbers, built by starting from random noise
  and nudging it ~10 times into a motion. Scratchy can't run that nudging or
  send such an answer back.
- **Ops**: attention that reads the prefix KV and is bidirectional (or
  block-causal) within its own block; sinusoidal timestep embedding; adaptive
  RMSNorm (pi0.5); cross-attention (SmolVLA, GR00T).
  These are the new GPU moves the action expert needs: peeking at the big
  model's notes, knowing how far along the nudging it is, and adjusting each
  layer by that.
- **Spyre** has no vision path at all.
  The IBM accelerator can't see pictures yet, so robot models stay off it for
  now.

## Design

The rules for how the pieces fit together. A small "action expert"
sits beside the big model and reads its notes instead of redoing its work.
It turns random noise into a smooth arm motion in ~10 small nudges, all on
the GPU so nothing ships back and forth. The picture-plus-instruction is read
in one gulp (splitting it would break the look-both-ways reading), and since
every camera frame is new, we don't bother caching it.

**The action expert is a head arch**, modelled on MTP heads:

- its own `dsl/<arch>.py` and `configs/<arch>/arch.json`, with
  `checkpoint_of: [<vlm-arch>]` and the prefix where its tensors sit in the
  VLM's checkpoint;
- it attends the VLM's KV cache through a new prefix-attention op;
- its per-call inputs are new externs: `noisy_actions`, `timestep`, `state`;
- its dimensions (pi0's Gemma 300M expert) are not in the VLM's `config.json`;
  they come from the arch's `.overrides.json`;
- it compiles under an `action-heads` feature, next to `mtp-heads`.

**The suffix mask is a compile-time constant.** The suffix is fixed-size
(state + `action_horizon` tokens), so its block-causal pattern is baked into
the op, not passed as a runtime mask.

**The worker runs the denoising loop on the host.** Each Euler step
(10 for pi0, 4 for GR00T) is one fixed-shape call of the head, which outputs
`x_next = x + dt·v` itself (one elementwise op), so the actions stay on the
device between steps and the output buffer feeds the next step's input. The
step timesteps are constants, so their N sinusoidal embeddings are
precomputed once (a table, not an op). The DSL gains ops, not control flow;
unrolling the whole loop into one tape is a Phase 6 option.

**An action request prefills its whole prefix in one chunk.** A chunk
boundary inside a bidirectional prefix is wrong whatever is cached, so the
encoder cache does not help here; one chunk also removes the
vision-on-the-first-chunk-only limit for these requests.

**Action requests are `volatile`.** Fresh camera frames every call mean the
prefix cache never hits; the scheduler already treats `volatile` as one-shot
(`core.rs`, next to `is_pooling`), so nothing is cached or hashed.

**Shapes stay compile-time constants.** `action_horizon`, `action_dim` and the
step count come from the config; the head's bucket ladder is
`batch × action_horizon`.

## Phases

The order we build in, so each step stands on a finished one.

### Phase 0: scope and goldens

Before cooking, write down exactly what the dish should taste like.
We run the official models once on fixed inputs and save the answers
("goldens"); our version must match them. We also decide how fast is fast
enough, because a robot waiting on its brain is a robot standing still.

1. Pin target checkpoints: OpenVLA-7B, pi0 / pi0.5 (openpi or LeRobot ports),
   SmolVLA, GR00T N1.5.
2. Generate goldens with LeRobot as the single reference (PyTorch ports of
   pi0, pi0.5, SmolVLA, GR00T; no JAX/Orbax conversion), `openvla` for
   OpenVLA: fixed image + instruction + state + passed-in noise → actions.
   Record intermediates too: prefix KV and the step-0 velocity, since errors
   compound over the Euler steps. They live with the existing goldens in
   `crates/e2e/testdata/`.
2b. Set a latency target per action chunk (e.g. pi0 < ~100 ms on M4 Max).
   VLA serving is mostly batch-1 and judged on latency, so measure per-call
   scheduler overhead from the first end-to-end run.
3. Record the head-arch decision as an ADR (`docs/adr/`) once agreed.

### Phase 1: OpenVLA (actions as tokens)

OpenVLA cheats in a useful way: it "says" its arm movements as 7
special words, each meaning one of 256 positions. Scratchy already knows how
to say words, so this needs new eyes and a translator from words back to
numbers, but no new kind of output.

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

The robot's mailbox. Today Scratchy accepts chat messages; a robot
sends several camera pictures plus "where my joints are right now" and wants
movements back. We add a door for that, scale the robot's numbers to the
range the model learned on (and back), and mark these requests as one-shot
so the server doesn't keep leftovers it will never reuse.

9. API: `/v1/actions` taking
   `{images: {<camera>: …}, state: [f32], instruction, unnorm_key, seed}` and
   returning `actions: [[f32; action_dim]; horizon]`. Images as raw uint8 HWC
   arrays as well as `data:` URIs (no per-step PNG decode). Then a WebSocket
   mode compatible with openpi policy servers (msgpack-numpy), which is what
   existing robot clients speak.
10. Core types: named camera views with an absent-camera mask (pi0's image
    mask) and `state: Option<Vec<f32>>` on `MultimodalData`. Action requests
    are `volatile`, so the state needs no prefix-cache hashing.
10b. Host normalizer per checkpoint, both directions: normalize the state in
    (mean/std for pi0, quantiles for pi0.5) and un-normalize actions out,
    honouring delta vs absolute dimensions (gripper); stats from LeRobot's
    processor files or `norm_stats`.
11. Chunked prefill: an action request's prefix is scheduled as one chunk
    (see Design). The encoder cache stays unwired; it is long-context VLM
    work, not VLA work.
12. Request kind `action`, alongside `is_pooling`: prefill, then the action
    head, then finish, with no sampling loop.

### Phase 3: continuous action heads (compiler + targets)

New moves the GPU must learn. First and most important: reading the
picture-plus-instruction both ways while still saving notes for later. Then
the action expert's own moves: peeking at those notes, and the small update
step that turns noise into motion. Each move is written once per GPU type.

13. New ops, each one registry row plus one emitter arm per target (metal,
    cuda; on cuda also an ISel `Implementation`), and a torch definition for
    the CI oracle, per the invariants in [`CLAUDE.md`](../CLAUDE.md):
    - first, `prefix_lm_attention`: decoder prefill attention that is
      bidirectional over the prefix and writes the KV cache (the gate for
      pi0, pi0.5 and SmolVLA);
    - `prefix_attention(q, k, v, kv_cache, block_table)`: prefix KV plus the
      action block, block-causal within the block by a compile-time mask;
      extends `shared_attention` (check its target-side lowering first);
    - no `timestep_embed` op: the per-step embeddings are a precomputed table;
    - `ada_rmsnorm(x, cond, w)` for pi0.5;
    - `cross_attention(q, ctx_k, ctx_v)`, for GR00T only if SmolVLA's
      cross-attention layers turn out to read the VLM's per-layer K/V (then
      they are `prefix_attention` with a K/V projection); check LeRobot.
14. Externs `noisy_actions`, `timestep`, `state` in `ExternKind`
    (`crates/compiler/macros/src/classified.rs`), shape-inferred from
    `action_horizon` / `action_dim`.
15. `ActionHeadRegistration` next to `HeadRegistration`
    (`crates/compiler/src/heads.rs`): VLM arches it attaches to, weight prefix,
    horizon, action dim, step count, solver. Registered via `inventory::submit!`.
16. Worker loop: seeded Gaussian noise; per step, one head call that
    outputs `x_next` on the device (see Design); un-normalize and return. Batch all requests' action blocks
    into one bucket.

### Phase 4: pi0 / pi0.5

pi0 is the popular "real" robot brain: a picture-and-language model
(PaliGemma) plus a small expert that draws smooth motions. We need its exact
eyes and language brain, then plug in the Phase 3 expert. pi0.5 adds a dial
that tells each layer how far along the noise-to-motion journey it is.

17. PaliGemma backbone: SigLIP at 224 px, no pooling, linear projector (close
    to `dsl/gemma3-mm.py`); Gemma-1 2B decoder (no `gemma` v1 arch dir exists;
    see whether `gemma2` minus softcap and alternating layers covers it).
    Prefix-LM masking: image and text tokens attend each other bidirectionally;
    first check what `gemma3-mm` does for its image tokens today.
18. pi0 action expert carrier (Gemma 300M): attention over prefix KV plus
    `[state, action]` tokens, block-causal; time-conditioned action MLP.
19. pi0.5: adaptive-RMSNorm time conditioning; discretized state tokens in the
    prompt (processor change).

### Phase 5: SmolVLA, then GR00T (stretch)

SmolVLA is a small, cheap robot brain built on parts Scratchy
mostly has already, which makes it the easiest real test. GR00T is a big
NVIDIA one with a very different body; nice to have, but as much work as
everything else combined, so it waits.

20. SmolVLA: SmolVLM2 vision tower with pixel-shuffle connector on the existing
    SmolLM2 decoder; run only the first `num_vlm_layers` (bound override in
    `arch.json`); action expert alternating cross- and self-attention.
21. GR00T N1.5: Eagle VLM backbone; DiT action head cross-attending backbone
    features (reuses `cross_attention`); per-embodiment state/action encoders.

### Phase 6: performance, targets, docs

Make it fast, check it on every GPU we promise, and write the
instructions so the next person can use it without asking us.

22. Benchmark latency per action chunk on metal and cuda, following
    [`BENCHMARKING.md`](BENCHMARKING.md).
23. Spyre: out of scope until it has a vision prelude.
24. Docs: a "VLA / action heads" section in [`MODELS.md`](MODELS.md) next to
    the MTP-heads section; `model/<stem>` features per VLA; a
    `scr serve … --runner action` example.

## Risks to check early

Places where the floor might be rotten. Poke them first, before we
build a house on top.

- **Prefix-LM masking in the decoder** is now a work item (Phase 3, first op),
  not a risk; it is still likely the largest change in `impl_lib.rs` /
  `codegen.rs`. Check what `gemma3-mm` does for its image tokens today.
- **pi0's mixture-of-experts attention** (shared attention, separate weights
  per token group) may force a joint forward instead of a head that only reads
  prefix KV. In the original pi0 the prefix sees nothing of the suffix, so
  reading prefix KV should be exact; confirm against openpi.
- **Weights**: openpi ships JAX/Orbax; needs a conversion path or the LeRobot
  safetensors ports.
- **Numerics**: flow-matching output depends on noise, so goldens fix the seed
  and pass the noise in.

## Open questions

Choices only we can make. Each one changes what gets built first,
so each has a recommended answer to save time.

1. First model: OpenVLA (Phase 1) or pi0 / SmolVLA (the real design)?
   Recommended: SmolVLA. OpenVLA's DINOv2 + LayerScale + dual-tower processor
   is reused by nothing later; SmolVLA reuses the compiled SmolLM2 and a
   SigLIP close to `gemma3-mm`, ships safetensors, and exercises prefix-LM,
   prefix attention and the flow loop. OpenVLA stays a side track (it works
   through the chat API with `allowed_token_ids`).
2. Targets: metal first, or metal and cuda together?
   Recommended: metal to iterate, cuda before calling it done (robots deploy
   on Jetson / desktop GPUs).
3. API: OpenAI-style endpoint, openpi/LeRobot WebSocket compatibility, or both?
   Recommended: both, `/v1/actions` first (tests, goldens), then openpi's
   WebSocket protocol.

Recommended order if (1) is SmolVLA: Phase 0 (goldens, latency target) →
Phase 2 (volatile, one chunk, normalizer, `/v1/actions`) → `prefix_lm_attention`
→ rest of Phase 3 → SmolVLA end to end on metal → Phase 4 → cuda → Phase 1
(OpenVLA) and GR00T as optional.
