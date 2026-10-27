#!/usr/bin/env bun
// A/B/C eval of the hierarchical AGENTS.md docs with headless Claude Code.
//   bun scripts/agents-md-eval/eval.ts materialize --arm A|B|C --dir <worktree>
//   bun scripts/agents-md-eval/eval.ts clean
//   bun scripts/agents-md-eval/eval.ts preflight   (writes ${OUT}/preflight.json; exit 1 unless every arm's docs load)
//   run: refuses unless preflight.json is ok for the current claude version; grade|report|selftest|smoke: later todos
// Env: AMD_EVAL_BASE (default acc4046b), AMD_EVAL_DOCS_REF (default docs/agents-md),
//      AMD_EVAL_OUT (default /tmp/scratchy-amd-eval).
import { $ } from "bun";
import { parseArgs } from "util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { ARMS, materialize, resolveCommit, type Arm } from "./arms";
import { preflight, preflightGate } from "./preflight";

const REPO = join(import.meta.dir, "../..");
const OUT = process.env.AMD_EVAL_OUT ?? "/tmp/scratchy-amd-eval";
const BASE = process.env.AMD_EVAL_BASE ?? "acc4046b";
const DOCS_REF = process.env.AMD_EVAL_DOCS_REF ?? "docs/agents-md";
const MANIFEST = join(OUT, "manifest.json");

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    arm: { type: "string" },
    dir: { type: "string" },
    reps: { type: "string" },
    probes: { type: "string" },
    arms: { type: "string" },
    model: { type: "string" },
    jobs: { type: "string" },
    ns: { type: "string" },
  },
});
const cmd = positionals[0];

const die = (msg: string, code = 1): never => { console.error(msg); process.exit(code); };
const readManifest = (): { worktrees: string[] } & Record<string, unknown> =>
  existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : { worktrees: [] };

async function materializeCmd() {
  const arm = o.arm as Arm;
  if (!ARMS.includes(arm)) die(`--arm must be one of ${ARMS.join(", ")} (got '${o.arm ?? ""}')`);
  if (!o.dir) die("--dir <worktree> is required");
  await resolveCommit(BASE).catch((e) => die(`${e.message} (AMD_EVAL_BASE)`));
  await resolveCommit(DOCS_REF).catch((e) => die(`${e.message} (AMD_EVAL_DOCS_REF)`));
  const { files } = await materialize(arm, o.dir!, DOCS_REF).catch((e) => die(String(e.message ?? e)));
  console.log(`arm ${arm}: wrote ${files.length} file(s) in ${o.dir}`);
}

async function clean() {
  const m = readManifest();
  for (const wt of m.worktrees) {
    const r = await $`git -C ${REPO} worktree remove --force ${wt}`.quiet().nothrow();
    console.log(`remove ${wt}: ${r.exitCode === 0 ? "ok" : r.stderr.toString().trim()}`);
  }
  await $`git -C ${REPO} worktree prune`.quiet();
  if (existsSync(MANIFEST)) writeFileSync(MANIFEST, JSON.stringify({ ...m, worktrees: [] }, null, 2));
  console.log(`clean: ${m.worktrees.length} harness worktree(s) listed in ${MANIFEST}`);
}

async function preflightCmd() {
  mkdirSync(OUT, { recursive: true });
  const edit = (f: (w: string[]) => string[]) => {
    const m = readManifest();
    writeFileSync(MANIFEST, JSON.stringify({ ...m, worktrees: f(m.worktrees) }, null, 2));
  };
  const code = await preflight({
    out: OUT, base: BASE, docsRef: DOCS_REF,
    addWorktree: (wt) => edit((w) => [...new Set([...w, wt])]),
    dropWorktree: (wt) => edit((w) => w.filter((x) => x !== wt)),
  }).catch((e) => die(`preflight: ${e.message ?? e}`));
  process.exit(code);
}

async function runCmd() {
  const refusal = await preflightGate(OUT);
  if (refusal) die(refusal);
  die("run: not implemented (todo 5)", 2);
}

if (cmd === "materialize") await materializeCmd();
else if (cmd === "clean") await clean();
else if (cmd === "preflight") await preflightCmd();
else if (cmd === "run") await runCmd();
else if (["grade", "report", "selftest", "smoke"].includes(cmd)) die(`${cmd}: not implemented`, 2);
else die("usage: eval.ts run|grade|report|selftest|preflight|materialize|clean|smoke", 2);
