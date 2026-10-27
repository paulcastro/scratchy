// `eval.ts grade [--ns matrix|dry-run]`: grades every ${OUT}/<ns>/runs/**/result.json into ${OUT}/<ns>/grades.json
// (GradeRow[], see report.ts). Ported from scratchy-perf-skill-eval:scripts/skill-eval/eval.ts (answerLine,
// numbers_any, regex_all, cargo_test), with the check field names probes.json uses.
//
// Answer text: every answer_format starts with "ANSWER:", so regex_all, not_patterns (not_on "answer_line"),
// set_eq and numbers_any all run on the LAST line that starts with "ANSWER:" (leading markdown `*`, `>`, `` ` ``,
// `_` and whitespace allowed); a reply without one fails. `not_on: "final"` would scan the whole final text instead.
// set_eq and numbers_any strip backticks, quotes and `*` first.
//
// Edit probes: the diff is `git diff <BASE> -- <probe paths>` plus untracked files under them, with every
// CLAUDE.md / AGENTS.md (the arm docs and shims) and the hook log excluded, so arm materialization never counts.
// The diff is applied in a fresh detached BASE worktree, cargo runs there with CARGO_TARGET_DIR=<targetDir>,
// and the worktree is removed afterwards.
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { parseEvents } from "./claude";
import type { GradeRow } from "./report";

const REPO = join(import.meta.dir, "../..");
export const PROBES: any[] = JSON.parse(readFileSync(join(import.meta.dir, "probes.json"), "utf8")).probes;
export const TRAPS: { name: string; regex: string; where: "edits" | "commands" }[] =
  JSON.parse(readFileSync(join(import.meta.dir, "probes.json"), "utf8")).traps;
const NOT_GRADED = [":(exclude,glob)**/CLAUDE.md", ":(exclude,glob)**/AGENTS.md", ":(exclude,glob)**/.amd-loaded.jsonl"];

export type Verdict = { pass: boolean; note: string };
export type EditEnv = { base: string; targetDir: string; wtRoot: string };

export function answerLine(final: string): string | null {
  const ls = String(final ?? "").split("\n").filter((l) => /^[\s>*`_]*ANSWER:/.test(l));
  return ls.length ? ls.at(-1)!.slice(ls.at(-1)!.indexOf("ANSWER:")).trim() : null;
}
const unquote = (s: string) => s.replace(/[`"'*]/g, "");
const rx = (re: string) => new RegExp(re.replace(/^\(\?i\)/, ""), re.startsWith("(?i)") ? "i" : "");

export function gradeAnswer(p: any, final: string): Verdict {
  const c = p.check, line = answerLine(final);
  if (line == null) return { pass: false, note: "no ANSWER line" };
  if (c.type === "regex_all") {
    const miss = c.patterns.filter((re: string) => !rx(re).test(line));
    const scan = c.not_on === "final" ? String(final) : line;
    const hit = (c.not_patterns ?? []).filter((re: string) => rx(re).test(scan));
    return { pass: !miss.length && !hit.length, note: [...miss.map((m: string) => `missing ${m}`), ...hit.map((h: string) => `forbidden ${h}`)].join(" | ") };
  }
  if (c.type === "set_eq") {
    const m = unquote(line).match(new RegExp(`\\b${c.field}\\s*=\\s*(.*)$`));
    if (!m) return { pass: false, note: `no ${c.field}=` };
    const norm = (s: string) => (c.normalize === "underscore_to_dash" ? s.replaceAll("_", "-") : s).trim();
    const got = new Set(m[1].split(",").map(norm).filter(Boolean)), want = new Set(c.values.map(norm));
    const pass = got.size === want.size && [...want].every((v) => got.has(v));
    return { pass, note: `got ${[...got].join(",")}` };
  }
  if (c.type === "numbers_any") {
    const v = parseFloat(unquote(line).replace(/^.*ANSWER:\s*/, ""));
    return { pass: Math.abs(v - c.value) <= c.abs_tol, note: `got ${v}` };
  }
  return { pass: false, note: `check type ${c.type} is not an answer check` };
}

export async function probeDiff(wt: string, base: string, paths: string[]): Promise<string> {
  const spec = [...paths, ...NOT_GRADED];
  let diff = (await $`git diff --binary ${base} -- ${spec}`.cwd(wt).quiet()).stdout.toString();
  const untracked = (await $`git ls-files --others --exclude-standard -- ${spec}`.cwd(wt).quiet().text()).split("\n").filter(Boolean);
  for (const f of untracked) diff += (await $`git diff --binary --no-index -- /dev/null ${f}`.cwd(wt).quiet().nothrow()).stdout.toString();
  return diff;
}

const testsRan = (out: string) => [...out.matchAll(/^test result: ok\. (\d+) passed/gm)].reduce((a, m) => a + Number(m[1]), 0);

async function inFreshWorktree<T>(env: EditEnv, name: string, diff: string, fn: (wt: string) => Promise<T>): Promise<T | Verdict> {
  mkdirSync(env.wtRoot, { recursive: true });
  const wt = join(env.wtRoot, `grade-${name}-${process.pid}`);
  await $`git -C ${REPO} worktree remove --force ${wt}`.quiet().nothrow();
  rmSync(wt, { recursive: true, force: true });
  await $`git -C ${REPO} worktree add --detach ${wt} ${env.base}`.quiet();
  try {
    if (diff) {
      const pf = `${wt}.patch`;
      writeFileSync(pf, diff);
      const a = await $`git apply --whitespace=nowarn ${pf}`.cwd(wt).quiet().nothrow();
      rmSync(pf, { force: true });
      if (a.exitCode !== 0) return { pass: false, note: `diff does not apply to BASE: ${a.stderr.toString().trim().slice(0, 300)}` };
    }
    return await fn(wt);
  } finally {
    await $`git -C ${REPO} worktree remove --force ${wt}`.quiet().nothrow();
    rmSync(wt, { recursive: true, force: true });
  }
}

const cargo = (wt: string, env: EditEnv, args: string[]) =>
  $`cargo test ${args} 2>&1`.cwd(wt).env({ ...process.env, CARGO_TARGET_DIR: env.targetDir }).quiet().nothrow();

export async function gradeEdit(p: any, runWt: string, env: EditEnv): Promise<Verdict> {
  if (!existsSync(join(runWt, ".git"))) return { pass: false, note: `run worktree missing: ${runWt}` };
  const c = p.check, diff = await probeDiff(runWt, env.base, p.paths);
  if (!diff.trim()) return { pass: false, note: "no diff under the probe paths" };
  if (c.type === "cargo_test") {
    if (!diff.includes(c.diff_contains)) return { pass: false, note: `diff lacks ${JSON.stringify(c.diff_contains)}` };
    return inFreshWorktree(env, p.id, diff, async (wt) => {
      const t = await cargo(wt, env, ["-p", c.package, ...(c.lib ? ["--lib"] : []), c.test]);
      const out = t.stdout.toString(), n = testsRan(out);
      // Exit 0 with "0 passed" (test missing or filtered out) is a fail, not a pass.
      const named = new RegExp(`^test (\\S+::)?${c.test} \\.\\.\\. ok$`, "m").test(out);
      return { pass: t.exitCode === 0 && n >= 1 && named, note: `exit=${t.exitCode} passed=${n} named=${named}` };
    });
  }
  if (c.type === "cargo_compile") {
    return inFreshWorktree(env, p.id, diff, async (wt) => {
      const f = join(wt, c.file);
      if (!existsSync(f)) return { pass: false, note: `${c.file} missing` };
      const src = readFileSync(f, "utf8");
      const miss = c.file_patterns.filter((re: string) => !rx(re).test(src));
      const hit = (c.forbid_patterns ?? []).filter((re: string) => rx(re).test(src));
      if (miss.length || hit.length) return { pass: false, note: [...miss.map((m: string) => `missing ${m}`), ...hit.map((h: string) => `forbidden ${h}`)].join(" | ") };
      const t = await cargo(wt, env, ["-p", c.package, "--test", c.test]);
      const n = testsRan(t.stdout.toString());
      return { pass: t.exitCode === 0 && n >= 1, note: `exit=${t.exitCode} passed=${n}` };
    });
  }
  return { pass: false, note: `check type ${c.type} is not an edit check` };
}

export function trapHits(transcript: string): string[] {
  const uses = parseEvents(transcript).filter((e) => e.type === "assistant").flatMap((e) => e.message?.content ?? []).filter((c: any) => c?.type === "tool_use");
  const hits: string[] = [];
  for (const u of uses) {
    const where = u.name === "Bash" ? "commands" : ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(u.name) ? "edits" : null;
    if (!where) continue;
    const text = where === "commands" ? String(u.input?.command ?? "") : JSON.stringify(u.input ?? {});
    for (const t of TRAPS) if (t.where === where && rx(t.regex).test(text)) hits.push(t.name);
  }
  return hits;
}

export async function gradeRun(r: any, transcript: string, env: EditEnv): Promise<GradeRow> {
  const p = PROBES.find((x) => x.id === r.probe);
  const { final: _f, stderr: _s, ...metrics } = r;
  const row = (v: Verdict): GradeRow => ({ ...metrics, group: p?.group, pass: v.pass, note: v.note, trap_hits: trapHits(transcript) });
  if (!p) return row({ pass: false, note: `unknown probe ${r.probe}` });
  if (!transcript.trim()) return row({ pass: false, note: "empty transcript" });
  return row(p.kind === "edit" ? await gradeEdit(p, r.wt, env) : gradeAnswer(p, r.final ?? ""));
}

export async function gradeCmd(out: string, base: string, ns: string): Promise<number> {
  const runs = join(out, ns, "runs");
  if (!existsSync(runs)) { console.error(`grade: no runs under ${runs}`); return 1; }
  const env: EditEnv = { base: (await $`git -C ${REPO} rev-parse --verify ${base + "^{commit}"}`.quiet().text()).trim(), targetDir: join(out, "cargo-target", "grade"), wtRoot: `${out}-wt` };
  const rows: GradeRow[] = [];
  for (const f of (await $`find ${runs} -name result.json`.quiet().text()).trim().split("\n").filter(Boolean).sort()) {
    const r = JSON.parse(readFileSync(f, "utf8"));
    const tf = f.replace(/result\.json$/, "transcript.jsonl");
    rows.push(await gradeRun(r, existsSync(tf) ? readFileSync(tf, "utf8") : "", env));
  }
  writeFileSync(join(out, ns, "grades.json"), JSON.stringify(rows, null, 2));
  console.log(`graded ${rows.length} run(s), ${rows.filter((r) => r.pass).length} pass -> ${join(out, ns, "grades.json")}`);
  return 0;
}
