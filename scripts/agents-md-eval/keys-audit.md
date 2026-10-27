# agents-md A/B probe answer keys (BASE = acc4046b)

Every key below comes from code at BASE, not from AGENTS.md text. Each row is re-checked by
`git grep -n -F -e '<text>' acc4046b -- <path>` and must print `acc4046b:<path>:<line>:`.
Docs ref: `docs/agents-md` holds 40 AGENTS.md files (plan said 41).

## Evidence greps

| probe | path:line | matched text |
|---|---|---|
| metal-skip | crates/targets/metal/tests/affine_gather_qmv_test.rs:180 | `let Some(mdev) = detect_device() else {` |
| metal-skip | crates/targets/metal/tests/affine_gather_qmv_test.rs:181 | `eprintln!("skipping: no Metal 4 GPU");` |
| metal-skip | crates/targets/metal/src/lib.rs:319 | `pub use device::{MetalDevice, detect_device, metal4_available};` |
| head-dim | crates/targets/metal/build.rs:52 | `const STEEL_PAGED_HEAD_DIMS: &[(u32, u32)] = &[(64, 16), (96, 16), (128, 32), (256, 16)];` |
| splice-memo | crates/triton/splice/src/lib.rs:2571 | `fn memo_key(src: &str, spec: &KernelSpec, grid: &[i64]) -> Option<String> {` |
| splice-memo | crates/triton/splice/src/lib.rs:2640 | `key.push_str(src);` |
| seam-test | crates/serving/scheduler/tests/zz_kv_extent_spans_the_worker_and_the_allocator.rs:54 | `#[test]` |
| seam-test | crates/serving/scheduler/Cargo.toml:2 | `name = "scratchy-serving-scheduler"` |
| emit-model | crates/compiler/macros/src/codegen.rs:13626 | `pub fn emit_model(` |
| emit-model | crates/compiler/macros/src/codegen.rs:13682 | `emit_weights_struct(` |
| emit-model | crates/compiler/macros/src/codegen.rs:15697 | `pub unsafe fn forward(` |
| weight-bindings | crates/compiler/macros/src/lib.rs:96 | `// Gated to the targets that consume it: metal (via 'emit_weight_bindings' /` |
| weight-bindings | crates/compiler/macros/src/codegen.rs:13777 | `(Some(l), Some(t)) => crate::weight_bindings::emit_weight_bindings(l, program, t)` |
| scoped-build | crates/cli/scr/Cargo.toml:2 | `name = "scratchy-cli"` |
| scoped-build | crates/cli/scr/Cargo.toml:84 | `metal = ["metal-base", "model?/turboquant", "model?/mtp-heads"]` |
| scoped-build | crates/cli/scr/Cargo.toml:154 | `model = { package = "scratchy-models", path = "../../models/arch", optional = true, default-features = false }` |
| scoped-build | crates/models/arch/Cargo.toml:223 | `"smollm2-135m" = ["arch-llama"]` |
| superdsc-deps | crates/targets/spyre/ktir/ktir-superdsc/Cargo.toml:30 | `serde = { workspace = true, features = ["derive"] }` |
| superdsc-deps | crates/targets/spyre/ktir/ktir-superdsc/Cargo.toml:40 | `serde_json = { workspace = true }` |
| superdsc-deps | crates/targets/spyre/ktir/ktir-superdsc/Cargo.toml:42 | `half = { workspace = true }` |
| superdsc-deps | crates/targets/spyre/ktir/ktir-superdsc/Cargo.toml:50 | `ktir-core = { path = "../ktir-core" }` |
| arch-count | crates/compiler/macros/tests/arch_declarations.rs:206 | `assert_eq!(seen, 31, "expected 31 DSL files, found {seen}");` |
| commit-scope | CLAUDE.md:109 | `both, scoped to the crate or area touched ('fix(metal): ...').` |
| new-opcode | crates/compiler/subtile/src/subtile_ir.rs:1100 | `RmsNorm { eps: f32, gain: GainConvention },` |
| new-opcode | crates/compiler/subtile/src/ops.rs:12 | `//! Adding an op = adding its variant (with its prose docs) and ONE row here. Every generated` |
| new-opcode | crates/targets/metal/compiler/src/steps_from_tape.rs:1982 | `L::RmsNorm { gain, .. } => self.norm(i, gain)?,` |
| new-opcode | crates/targets/metal/src/op_abi.rs:111 | `L::RmsNorm { .. } => FRESH.output(A::AbsorbedDelta).peel_through(0),` |
| new-opcode | crates/targets/spyre/src/lower_subtile_tape_to_ktir.rs:985 | `SubOp::RmsNorm { .. } => {` |
| new-opcode | crates/targets/spyre/src/lower_subtile_tape_to_superdsc.rs:588 | `SubOp::RmsNorm { eps, gain } => {` |
| write-sched-test | crates/serving/scheduler/src/scheduler/core.rs:3376 | `let mut token_budget = self.max_num_scheduled_tokens;` |
| write-sched-test | crates/serving/scheduler/src/scheduler/core.rs:3959 | `mod tests {` |
| write-sched-test | crates/serving/scheduler/src/scheduler/core.rs:4082 | `fn test_token_budget_limit() {` |
| metal-smoke-test | crates/targets/metal/src/device.rs:104 | `pub fn detect_device() -> Option<MetalDevice> {` |
| metal-smoke-test | crates/targets/metal/Cargo.toml:2 | `name = "scratchy-target-metal"` |
| metal-smoke-test | crates/targets/metal/src/device.rs:159 | `pub fn metal4_available() -> bool {` |
| ws-members | Cargo.toml:4 | `members = [` |

<!-- grep-rows (machine-read by the evidence loop): id<TAB>path<TAB>line<TAB>text -->
```tsv
metal-skip	crates/targets/metal/tests/affine_gather_qmv_test.rs	180	let Some(mdev) = detect_device() else {
metal-skip	crates/targets/metal/tests/affine_gather_qmv_test.rs	181	eprintln!("skipping: no Metal 4 GPU");
metal-skip	crates/targets/metal/src/lib.rs	319	pub use device::{MetalDevice, detect_device, metal4_available};
head-dim	crates/targets/metal/build.rs	52	const STEEL_PAGED_HEAD_DIMS: &[(u32, u32)] = &[(64, 16), (96, 16), (128, 32), (256, 16)];
splice-memo	crates/triton/splice/src/lib.rs	2571	fn memo_key(src: &str, spec: &KernelSpec, grid: &[i64]) -> Option<String> {
splice-memo	crates/triton/splice/src/lib.rs	2640	key.push_str(src);
seam-test	crates/serving/scheduler/tests/zz_kv_extent_spans_the_worker_and_the_allocator.rs	54	#[test]
seam-test	crates/serving/scheduler/Cargo.toml	2	name = "scratchy-serving-scheduler"
emit-model	crates/compiler/macros/src/codegen.rs	13626	pub fn emit_model(
emit-model	crates/compiler/macros/src/codegen.rs	13682	emit_weights_struct(
emit-model	crates/compiler/macros/src/codegen.rs	15697	pub unsafe fn forward(
weight-bindings	crates/compiler/macros/src/lib.rs	96	// Gated to the targets that consume it: metal (via `emit_weight_bindings` /
weight-bindings	crates/compiler/macros/src/codegen.rs	13777	(Some(l), Some(t)) => crate::weight_bindings::emit_weight_bindings(l, program, t)
scoped-build	crates/cli/scr/Cargo.toml	2	name = "scratchy-cli"
scoped-build	crates/cli/scr/Cargo.toml	84	metal = ["metal-base", "model?/turboquant", "model?/mtp-heads"]
scoped-build	crates/cli/scr/Cargo.toml	154	model = { package = "scratchy-models", path = "../../models/arch", optional = true, default-features = false }
scoped-build	crates/models/arch/Cargo.toml	223	"smollm2-135m" = ["arch-llama"]
superdsc-deps	crates/targets/spyre/ktir/ktir-superdsc/Cargo.toml	30	serde = { workspace = true, features = ["derive"] }
superdsc-deps	crates/targets/spyre/ktir/ktir-superdsc/Cargo.toml	40	serde_json = { workspace = true }
superdsc-deps	crates/targets/spyre/ktir/ktir-superdsc/Cargo.toml	42	half = { workspace = true }
superdsc-deps	crates/targets/spyre/ktir/ktir-superdsc/Cargo.toml	50	ktir-core = { path = "../ktir-core" }
arch-count	crates/compiler/macros/tests/arch_declarations.rs	206	assert_eq!(seen, 31, "expected 31 DSL files, found {seen}");
commit-scope	CLAUDE.md	109	both, scoped to the crate or area touched (`fix(metal): ...`).
new-opcode	crates/compiler/subtile/src/subtile_ir.rs	1100	RmsNorm { eps: f32, gain: GainConvention },
new-opcode	crates/compiler/subtile/src/ops.rs	12	//! Adding an op = adding its variant (with its prose docs) and ONE row here. Every generated
new-opcode	crates/targets/metal/compiler/src/steps_from_tape.rs	1982	L::RmsNorm { gain, .. } => self.norm(i, gain)?,
new-opcode	crates/targets/metal/src/op_abi.rs	111	L::RmsNorm { .. } => FRESH.output(A::AbsorbedDelta).peel_through(0),
new-opcode	crates/targets/spyre/src/lower_subtile_tape_to_ktir.rs	985	SubOp::RmsNorm { .. } => {
new-opcode	crates/targets/spyre/src/lower_subtile_tape_to_superdsc.rs	588	SubOp::RmsNorm { eps, gain } => {
write-sched-test	crates/serving/scheduler/src/scheduler/core.rs	3376	let mut token_budget = self.max_num_scheduled_tokens;
write-sched-test	crates/serving/scheduler/src/scheduler/core.rs	3959	mod tests {
write-sched-test	crates/serving/scheduler/src/scheduler/core.rs	4082	fn test_token_budget_limit() {
metal-smoke-test	crates/targets/metal/src/device.rs	104	pub fn detect_device() -> Option<MetalDevice> {
metal-smoke-test	crates/targets/metal/Cargo.toml	2	name = "scratchy-target-metal"
metal-smoke-test	crates/targets/metal/src/device.rs	159	pub fn metal4_available() -> bool {
ws-members	Cargo.toml	4	members = [
```

## Non-grep evidence

- commit-scope: `git log acc4046b -300 --format=%s | grep -c '^fix(metal):'` = 7 (e.g. "fix(metal): build one pipeline state at a time in the process (#899)"). The key is a convention, so git history is the code-side evidence; CLAUDE.md:109 states it.
- ws-members: TOML array `acc4046b:Cargo.toml` [workspace] `members = [` (line 4) has **39** quoted entries. `cargo metadata --no-deps --format-version 1 | jq '.workspace_members|length'` in a detached scratch worktree at acc4046b = **40**. The extra member is `crates/targets/spyre/flex-rs`, auto-included as a path dependency of a member. Per the plan the counts differ, so the key uses the TOML count (39) and the prompt asks for "entries ... the [workspace] members array lists". Scratch worktree removed (`git worktree list | grep -c amd-ws` = 0).
- write-sched-test: 2041 = max_num_batched_tokens 2048 - 7 running decode requests x 1 token; the scheduler draws every step from one `token_budget = self.max_num_scheduled_tokens` (core.rs:3376). Copied from `scratchy-perf-skill-eval:scripts/skill-eval/probes.json` probe `write-test`, renamed.
- metal-smoke-test: graded by `cargo test -p scratchy-target-metal --test amd_smoke_test` (exit 0) plus file patterns; `.commandBuffer()` is banned in `clippy.toml`.

## Key corrections against the plan / docs

- **new-opcode (doc claim false)**: root AGENTS.md says a new opcode is `Instruction` in `crates/compiler/ir/src/lib.rs` "+ one emitter arm per target". At BASE neither metal nor spyre matches `Instruction::` in code (`git grep -n 'Instruction::' acc4046b -- crates/targets/spyre/src` = no hits; in `crates/targets/metal/src` every hit is a comment). Both consume the shared subtile IR `SubOp` (`crates/compiler/subtile/src/subtile_ir.rs:1022 pub enum SubOp`), whose `ops.rs` rows generate exhaustive matches. Real per-target match sites for an existing op (`SubOp::RmsNorm`): metal `crates/targets/metal/compiler/src/steps_from_tape.rs:1982` and `crates/targets/metal/src/op_abi.rs:111` (exhaustive, E0004); spyre `crates/targets/spyre/src/lower_subtile_tape_to_ktir.rs:985` (exhaustive, E0004) and `lower_subtile_tape_to_superdsc.rs:588`. Regexes require the subtile IR file plus one metal and one spyre site. scope_dir moved to `crates/compiler/subtile`.
- **ws-members**: prompt rephrased to "entries in the members array" because cargo metadata (40) != TOML (39).
- **arch-count**: the test asserts `seen == 31` (arch_declarations.rs:206) but BASE has 32 `.py` files in `crates/models/arch/dsl/`. The key (the file path) is unaffected; the stale count is a pre-existing bug, not part of the key.
- **emit-model**: regex tightened to `fn=\S*emit_model\b` so `emit_model_stub_items` (lib.rs:3403) and `emit_weights_struct` do not pass.

## Group labels

`child` = key term absent from `docs/agents-md:AGENTS.md`, `acc4046b:CLAUDE.md`, `acc4046b:crates/models/arch/dsl/CLAUDE.md`.

| probe | group | term | root-set hits | child doc(s) with the term |
|---|---|---|---|---|
| metal-skip | child | detect_device, "skipping: no Metal 4 GPU" | none | crates/targets/metal/AGENTS.md |
| head-dim | child | STEEL_PAGED_HEAD_DIMS | none | crates/targets/metal/AGENTS.md |
| splice-memo | child | memo_key | none | crates/triton/splice/AGENTS.md |
| seam-test | child | zz_kv_extent_spans_the_worker_and_the_allocator | none | crates/serving/scheduler/AGENTS.md |
| emit-model | child | emit_model | none | crates/compiler/macros/AGENTS.md |
| weight-bindings | child | weight_bindings | none | crates/compiler/macros/AGENTS.md |
| scoped-build | root | smollm2-135m | CLAUDE.md | crates/cli/AGENTS.md, crates/serving/AGENTS.md |
| superdsc-deps | root | serde_json | AGENTS.md (ANTI-PATTERNS) | ktir-superdsc, ktir, triton, triton-ktir-superdsc, serving/api AGENTS.md |
| arch-count | root | arch_declarations | AGENTS.md (NOTES) | crates/compiler/macros/AGENTS.md |
| commit-scope | root | fix(metal) | CLAUDE.md | none |
| new-opcode | cross | Instruction / SubOp sites | AGENTS.md (wrong answer) | crates/compiler/AGENTS.md (wrong answer) |
| write-sched-test | cross | test_decode_runs_beside_long_prefill, 2041 | none | none (edit task) |
| metal-smoke-test | cross | detect_device | none | crates/targets/metal/AGENTS.md |
| ws-members | neutral | workspace members count | none | none (no doc states 39/40) |

Relabels: none. Every plan label held.
