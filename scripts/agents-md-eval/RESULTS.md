# AGENTS.md eval results: hierarchical vs flat

**Recommendation: ship the hierarchical layout (arm B).** It had the best pass rate, the lowest cost per pass and the fewest input tokens. The flat layout cost about 1.7x as much per pass with no gain in accuracy.

## Setup

- **Model:** sonnet (`aws/claude-sonnet-5`), Claude Code 2.1.309.
- **Code under test:** BASE `acc4046b`; the docs were `docs/agents-md` at `a56888b3`.
- **Runs:** 14 probes x 3 arms x 2 reps = 84 graded runs, all in the `matrix` namespace. Total spend was $19.70.
- **Raw results:** `/tmp/scratchy-amd-eval/matrix/` (`grades.json`, `report.md`). These files are not committed.

| Arm | What the agent sees |
| --- | --- |
| A | No AGENTS.md, only the existing CLAUDE.md files |
| B | Hierarchical: one AGENTS.md per directory, loaded when the agent works there |
| C | Flat: the same content in one root AGENTS.md, always loaded |

## Results

| | A (none) | B (hierarchical) | C (flat) |
| --- | --- | --- | --- |
| Pass rate | 86% (24/28) | **96% (27/28)** | 89% (25/28) |
| Cost per pass | $0.222 | **$0.207** | $0.352 |
| Total spend | $5.33 | $5.58 | $8.79 |
| Median input tokens | 117k | **88k** | 91k |
| Median cache-write tokens | 10k | 14k | 70k |
| Median tool calls | 6 | 3 | 0 |
| Median searches before finding the right file (child probes) | 5 | **1** | n/a (answered from context) |
| Median wall time | 31s | 24s | **10s** |
| Trap hits | 0 | 0 | 0 |

Passes by probe group:

| Group | A | B | C |
| --- | --- | --- | --- |
| child (6 probes) | 12/12 | 12/12 | 12/12 |
| root (4) | 7/8 | **8/8** | 7/8 |
| cross (3) | 3/6 | **5/6** | 4/6 |
| neutral (1) | 2/2 | 2/2 | 2/2 |

## Findings

- **The docs help.** With docs, the agent found the right file after about 1 search instead of about 5, and used fewer tokens.
- **Hierarchical won where the arms differed.** All arms passed every child probe, so the differences came from the root and cross-cutting probes. Arm B was the only arm that passed every probe except `new-opcode`.
- **Flat is fast but expensive.** Arm C writes about 70k tokens of docs into the prompt cache on every run, compared with about 14k for B. That lets it answer with almost no tool calls, but it costs 1.7x B per pass, and the cost grows with every doc added.
- **Hierarchical loading worked as designed.** B loaded child docs in 16 of 28 runs, and only for the directories it touched. Probes about root-level facts loaded only the root doc.
- **Most failures came from one probe.** `new-opcode` had 4 of the 5 budget hits (A 0/2, B 1/2, C 1/2). The other failures were wrong answers on `commit-scope` (A, C), `metal-smoke-test` (A) and `write-sched-test` (C).
- **The run is reliable.** Budget hits aside, there were no timeouts or harness errors, which is under the README's 5% limit.

## Pre-registered verdict

Only one rule fired: **Detriment: harmful guidance**. The cause was a false claim in the docs, logged in `keys-audit.md`, not the hierarchy.

- **The false claim:** the docs said a new opcode goes in `Instruction` (`crates/compiler/ir/src/lib.rs`) plus "one emitter arm per target".
- **Why it was wrong:** `Instruction` is only the CUDA interpreter's opcode set. Metal and spyre lower `SubOp` (`crates/compiler/subtile/src/subtile_ir.rs`), whose facts come from `ops.rs`.
- **Who it affected:** arms B and C equally, and it matches the probe every arm failed most (`new-opcode`).
- **Status:** fixed in `docs/agents-md` (`5eed37e6`, "docs(agents-md): point new tape ops at SubOp, not Instruction"). The new text sends metal/spyre tape ops to `SubOp` plus `ops.rs` and their exhaustive match sites, and CUDA ops to `Instruction` plus `eval.rs`.

The two rules that would directly show a benefit (**hierarchy benefit** and **content benefit**) could not fire. Both compare child-group passes, and every arm passed all 12. So the recommendation rests on cost and on the root and cross-cutting results, not on a pre-registered rule.

## Caveats and next steps

- At 2 reps per probe, these results are directional, not statistically significant.
- The child probes were too easy to separate the arms. A rerun needs harder child probes for the hierarchy rule to be able to fire.
- To measure the `new-opcode` fix, rerun with the fixed docs and a fresh `AMD_EVAL_OUT`. Before that rerun, drop the "doc claim false" line from `keys-audit.md`. Its "Key corrections" section would also need updating to say the docs claim is fixed.
- Both branches have been rebased onto `upstream/main` (`4a5816e3`). The harness still defaults to BASE `acc4046b`, so a rerun on the new base needs `AMD_EVAL_BASE` set and the probe answer keys checked against it.
