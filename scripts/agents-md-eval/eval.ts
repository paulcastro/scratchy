#!/usr/bin/env bun
// A/B/C eval of the hierarchical AGENTS.md docs with headless Claude Code.
//   bun scripts/agents-md-eval/eval.ts materialize --arm A|B|C --dir <worktree>
//   bun scripts/agents-md-eval/eval.ts clean
//   bun scripts/agents-md-eval/eval.ts preflight   (writes ${OUT}/preflight.json; exit 1 unless every arm's docs load)
//   bun scripts/agents-md-eval/eval.ts run [--ns dry-run|matrix] [--model sonnet] [--reps 2] [--jobs 4] [--arms A,B,C] [--probes ids]
//     (refuses unless preflight.json is ok for the current claude version; spend cap AMD_EVAL_CAP_USD, default 150)
//   bun scripts/agents-md-eval/eval.ts selftest   (fake-launcher runner cases, then grader/trap/detector cases; costs nothing)
//   bun scripts/agents-md-eval/eval.ts grade [--ns matrix|dry-run]   (writes ${OUT}/<ns>/grades.json)
//   bun scripts/agents-md-eval/eval.ts report [--ns matrix|dry-run]   (writes ${OUT}/<ns>/report.md with the pre-registered verdict)
//   bun scripts/agents-md-eval/eval.ts freeze   (writes frozen.json: probes, grader, group labels, VERDICT_RULES hashes; commit it)
//   bun scripts/agents-md-eval/eval.ts smoke [--ns matrix] [run options]   (preflight -> selftest -> run -> grade -> report; stops at the first failure)
//   `run --ns matrix` refuses unless frozen.json matches and is committed (freeze.ts).
// Env: AMD_EVAL_BASE (default acc4046b), AMD_EVAL_DOCS_REF (default docs/agents-md),
//      AMD_EVAL_OUT (default /tmp/scratchy-amd-eval), AMD_EVAL_CAP_USD (default 150).
import { $ } from "bun";
import { parseArgs } from "util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { ARMS, materialize, resolveCommit, type Arm } from "./arms";
import { frozenGate, writeFrozen } from "./freeze";
import { gradeCmd } from "./grade";
import { gradeSelftest } from "./grade-selftest";
import { preflight, preflightGate } from "./preflight";
import { reportCmd } from "./report";
import { run } from "./run";
import { selftest } from "./selftest";

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

const editWorktrees = (f: (w: string[]) => string[]) => {
  const m = readManifest();
  writeFileSync(MANIFEST, JSON.stringify({ ...m, worktrees: f(m.worktrees) }, null, 2));
};

async function preflightCmd(): Promise<number> {
  mkdirSync(OUT, { recursive: true });
  return preflight({
    out: OUT, base: BASE, docsRef: DOCS_REF,
    addWorktree: (wt) => editWorktrees((w) => [...new Set([...w, wt])]),
    dropWorktree: (wt) => editWorktrees((w) => w.filter((x) => x !== wt)),
  }).catch((e) => { console.error(`preflight: ${e.message ?? e}`); return 1; });
}

async function runCmd(): Promise<number> {
  const refusal = await preflightGate(OUT);
  if (refusal) die(refusal);
  const arms = (o.arms ?? ARMS.join(",")).split(",") as Arm[];
  const bad = arms.filter((a) => !ARMS.includes(a));
  if (bad.length) die(`--arms: unknown arm(s) ${bad.join(",")}`);
  const ns = o.ns ?? "matrix";
  if (!["dry-run", "matrix"].includes(ns)) die(`--ns must be dry-run or matrix (got '${ns}')`);
  if (ns === "matrix") { const r = await frozenGate(); if (r) die(r); }
  const edit = editWorktrees;
  return run({
    out: OUT, base: BASE, docsRef: DOCS_REF, ns, model: o.model ?? "sonnet",
    reps: Number(o.reps ?? 2), jobs: Number(o.jobs ?? 4), arms, probes: o.probes ? o.probes.split(",") : null,
    addWorktree: (wt) => edit((w) => [...new Set([...w, wt])]),
  }).catch((e) => die(`run: ${e.message ?? e}`));
}

const selftestCmd = async () => (await selftest()) | (await gradeSelftest(OUT, BASE));

async function smoke(): Promise<number> {
  const ns = o.ns ?? "matrix";
  const steps: [string, () => Promise<number> | number][] = [
    ["preflight", preflightCmd], ["selftest", selftestCmd], ["run", runCmd],
    ["grade", () => gradeCmd(OUT, BASE, ns)], ["report", () => reportCmd(OUT, ns)],
  ];
  for (const [name, step] of steps) {
    console.log(`== smoke: ${name}`);
    const code = await step();
    if (code !== 0) { console.error(`smoke: ${name} exited ${code}; stopping`); return code; }
  }
  return 0;
}

if (cmd === "materialize") await materializeCmd();
else if (cmd === "clean") await clean();
else if (cmd === "preflight") process.exit(await preflightCmd());
else if (cmd === "run") process.exit(await runCmd());
else if (cmd === "selftest") process.exit(await selftestCmd());
else if (cmd === "grade") process.exit(await gradeCmd(OUT, BASE, o.ns ?? "matrix"));
else if (cmd === "report") process.exit(reportCmd(OUT, o.ns ?? "matrix"));
else if (cmd === "freeze") console.log(JSON.stringify(writeFrozen(), null, 2));
else if (cmd === "smoke") process.exit(await smoke());
else die("usage: eval.ts run|grade|report|selftest|preflight|materialize|clean|freeze|smoke", 2);
