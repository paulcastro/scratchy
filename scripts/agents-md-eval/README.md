# AGENTS.md A/B/C eval

Does the hierarchical AGENTS.md set on `docs/agents-md` help a coding agent, and does the hierarchy
itself matter? Headless Claude Code (`claude -p`) answers fixed probes in throwaway worktrees of BASE,
under three documentation arms. The probes are graded mechanically, and a verdict is computed from
rules registered before any results were seen.

## Arms

| Arm | Worktree contents |
| --- | --- |
| A | BASE untouched (only the existing CLAUDE.md files). |
| B | Every AGENTS.md from DOCS at its own path, plus a `@AGENTS.md` line in each dir's CLAUDE.md, so Claude Code loads child docs lazily when it touches that dir. |
| C | The same content flattened into one root AGENTS.md (each child doc under a `# <dir>/` header), loaded via the root CLAUDE.md. |

B vs C isolates the hierarchy. A vs B/C measures the content. `check-arms.sh` asserts the materializer rules.

## Commands, in order

Run from the repo root (`bun scripts/agents-md-eval/eval.ts <cmd>`):

1. `preflight`: canary docs in each arm prove the docs reach Claude through the InstructionsLoaded hook. It writes `${OUT}/preflight.json`, and `run` refuses unless that file is ok for the current claude version. Cost is about $1.
2. `selftest`: runner cases against a fake launcher, then grader, trap and detector cases. Costs nothing, but runs cargo.
3. `run --ns dry-run --reps 1 --probes metal-skip,ws-members --arms A,B,C`: a 6-run dry run. Dry-run rows never enter the verdict.
4. `grade --ns dry-run`, then `report --ns dry-run`.
5. `freeze`, then commit `frozen.json`. This pins the hashes of probes.json, grade.ts, the probe group labels and `VERDICT_RULES`. `run --ns matrix` refuses unless frozen.json matches the current files and all of them are committed. The hashes are also written to `${OUT}/manifest.json` under `frozen`.
6. `smoke --model sonnet --reps 2 --jobs 4 --arms A,B,C`: runs preflight, selftest, run, grade and report on the matrix namespace, and stops at the first nonzero step.
7. `clean`: removes the run worktrees listed in the manifest.

`run` resumes: settled runs are skipped. It refuses when existing results carry a different manifest hash (any edit to probes.json, arms.ts, claude.ts, run.ts, report.ts or grade.ts). Use a fresh `AMD_EVAL_OUT` in that case.

## Env vars

| Var | Default | Meaning |
| --- | --- | --- |
| `AMD_EVAL_BASE` | `acc4046b` | Commit the worktrees are made from (no AGENTS.md). |
| `AMD_EVAL_DOCS_REF` | `docs/agents-md` | Ref the AGENTS.md files are read from. |
| `AMD_EVAL_OUT` | `/tmp/scratchy-amd-eval` | Outputs: ledger, manifest, preflight, `<ns>/runs`, `grades.json`, `report.md`. Worktrees go in `${OUT}-wt`. |
| `AMD_EVAL_CAP_USD` | `150` | Ledger spend cap. Each call reserves about $1 before launch, and a reservation whose call is unresolved is never released. |

## Cost

Each sonnet run costs about $1 at most (the per-call budget). Most cost $0.05 to $0.30. The matrix is 14 probes x 3 arms x 2 reps = 84 runs, so it costs at most about $84, plus about $1 of preflight. Check spend with
`bun -e 'import {spend} from "./scripts/agents-md-eval/ledger"; console.log(spend(process.env.AMD_EVAL_OUT + "/ledger.jsonl"))'`.

## Reading the verdict

`report.md` has tables per arm (pass%, cost per pass, input tokens, tool calls, search_before_hit, traps, budget hits), per probe group (child, root, cross, neutral), per probe, and traps by arm. The `## Verdict` section uses only complete matched (model, probe, rep) A/B/C triplets from the `matrix` namespace, and lists every rule that fired:

- **Hierarchy benefit**: B beats C on child-group probes, by passes or by fewer searches before reaching the right file.
- **Content benefit**: B and C both beat A on child probes, but the hierarchy rule does not fire.
- **Detriment: regression / overhead / harmful guidance**: B loses root probes, costs too many tokens or dollars, or the docs lead into traps (or keys-audit.md lists a false doc claim).
- **Inconclusive**: no rule fired.

At 2 reps the result is directional, not significant. Also check the run summary: if more than 5% of runs had a nonzero exit, a timeout, or no result event, without a budget hit, treat the result as unreliable for harness reasons.
