# Generating Hyper-Specialized Inference Servers

In production AI inference, one question is quietly reshaping infrastructure:
why are we still using universal, one-size-fits-all inference servers?

Today's dominant serving engines are generalists. They are designed to run
almost any model on almost any hardware, dynamically parsing configuration files,
constructing compute graphs at load time, and negotiating memory layouts on the
fly. But generality comes with a steep price: multi-gigabyte container images,
tens of seconds of startup latency, runtime dispatch overhead, and complex
fallback logic.

Hyper-specialization flips this trade-off:

- **Minimal footprint, maximal performance:** An inference server built for
  exactly one model architecture, one quantization preset, and one hardware
  target eliminates dynamic dispatch and generic graph building entirely.
- **Pushing runtime decisions to compile time:** Buffer management, kernel
  selection, weight wiring, and tile geometries become compile-time constants
  instead of runtime guesses.
- **The trade-off:** A hyper-specialized server supports a narrower set of
  requirements. But in real-world deployments, workloads are predictable: you run
  a known model at a chosen precision on designated hardware.

At IBM Research, hyper-specialization is a compelling direction for the
IBM Spyre Accelerator. To unlock maximum inference throughput and efficiency on
our own silicon, we want execution paths tailored directly to the hardware
architecture without the overhead of generic runtime layers.

Historically, the obstacle to hyper-specialization was developer productivity.
Writing and maintaining dozens of bespoke servers by hand was simply too
expensive. AI coding tools change that calculus entirely: when generating,
adapting, and transcribing code becomes fast and reliable, building bespoke
software is no longer a luxury. Instead of deploying a single monolithic server,
we can generate a fleet of lightweight, hyper-specialized servers on demand.

## What "Reuse" Means in the Age of AI

This shift changes how we think about software reuse.

For fifty years, software reuse meant hauling along someone else's code: shared
libraries (`.so` files), source packages (`node_modules`), or heavy framework
dependencies. But traditional compilers hit a fundamental wall: they can prune
unused functions and specialize generics, but they cannot restructure the code.
The generality and architectural baggage of your dependencies remain yours.

When AI makes faithful code transcription cheap, the unit of reuse shifts from
the **module** to the **idea**.

Instead of importing an entire monolithic serving engine as a dependency, you
can extract its core serving algorithms — paged KV caches, continuous batching,
prefix caching — and transcribe them directly into a specialized compilation
pipeline. You reuse the algorithmic insight without inheriting the runtime bloat.

## Introducing Scratchy

[Scratchy](https://github.com/AI-native-Systems-Research/scratchy) is the
existence proof of this philosophy: a compiler that takes a model definition, a
HuggingFace `config.json`, and a hardware preset, and emits a lean, standalone
server tailored exclusively to that combination.

In Scratchy, model architectures are defined in high-level, declarative Rust.
Procedural macros do the heavy lifting at compile time — deriving weight wiring,
buffer layouts, and dispatch tables.

Here is the complete definition of LLaMA in Scratchy — the entire forward pass:

```rust
#[forward]
fn llama() {
    hidden_states = embed(input_ids, embed_tokens);
    for layer in 0..num_hidden_layers {
        normed = rmsnorm(hidden_states, input_layernorm[layer]);
        q = gemm(normed, self_attn.q_proj[layer]);
        k = gemm(normed, self_attn.k_proj[layer]);
        v = gemm(normed, self_attn.v_proj[layer]);
        (q, k, v) = rope_append(q, k, v, positions, rotary, kv_cache[layer]);
        attn = attention(q, k, v, kv_cache[layer], block_table);
        oproj = gemm(attn, self_attn.o_proj[layer]);
        hidden_states = add(oproj, hidden_states);

        normed2 = rmsnorm(hidden_states, post_attention_layernorm[layer]);
        gate = silu(gemm(normed2, mlp.gate_proj[layer]));
        up = gemm(normed2, mlp.up_proj[layer]);
        down = gemm(gate * up, mlp.down_proj[layer]);
        hidden_states = add(down, hidden_states);
    }
    normed = rmsnorm(hidden_states, norm);
    logits = gemm(normed, lm_head);
}
```

Twenty-two lines. Across the entire repository, 25 model architectures fit into
just 1,580 lines of code.

The payoff: a **30 MiB binary** with a **300 ms warm startup time**, independent
of model size, because the computation graph is fixed at compile time.

The serving algorithms are drawn directly from
[vLLM](https://github.com/vllm-project/vllm), transcribed into Rust and credited
by file and line at each use site. Seventy citations to a repository that never
enters the build graph — the ultimate expression of reuse at the idea level.

## Why This Matters for IBM Spyre

Hyper-specialization and compile-time guarantees are especially powerful on
novel, exotic hardware like the **IBM Spyre AIU**.

To understand why, imagine working at a tiny physical workbench that holds only a
couple of sheets of paper (1.6 MB of usable scratchpad memory per Spyre core).
Every chunk of math ("tile") must fit on that workbench:

- **The general runtime approach:** A runtime attempts to partition math into
  tiles dynamically while running on the hardware. If a tile is even one byte too
  large, the card faults minutes later with a cryptic `DtException 1535` error,
  leaving no way to identify which line of math caused the overflow.
- **The Scratchy approach:** Because Scratchy compiles specifically for the target
  hardware, every tile size is calculated at compile time. If an operation
  exceeds the 1.6 MB limit, `cargo build` fails immediately on the developer's
  laptop with a precise error and line number.

Supporting novel silicon with no existing ecosystem required about as much Rust
as supporting CUDA, and required **zero changes** to model code: the same
22-line LLaMA definition runs on both. An 8B model boots in 12 seconds from a
330 MiB container image.

## A New Threshold for Novel Silicon

Traditional reuse-by-code imposes a high population threshold on new hardware:
a chip vendor must maintain complex backends across multiple general-purpose
frameworks before developers can even experiment with it.

Reuse-by-idea, paired with AI-driven code generation, lowers that threshold to a
single team with a compiler. When hyper-specialized inference servers can be
generated on demand, novel silicon becomes practical at scales where it never
was before.

---

*Scratchy is Apache-2.0. Serving algorithms derive from vLLM; the Spyre hardware
model from IBM's `torch-spyre` and KTIR. Both Apache-2.0, credited at each
derivation site.*
