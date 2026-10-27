// `eval.ts selftest` cases for report.ts: synthetic grades.json rows against the pre-registered verdict rules.
// keys-audit text is passed in explicitly so the real "doc claim false" entry only appears where a case asks for it.
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { renderReport, verdict, type GradeRow } from "./report";

type Ctx = { out: string };
const check = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const FIXTURE: GradeRow[] = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/grades.synthetic.json"), "utf8"));

const row = (arm: GradeRow["arm"], probe: string, group: GradeRow["group"], rep: number, pass: boolean, o: Partial<GradeRow> = {}): GradeRow => ({
  ns: "matrix", model: "syn", arm, probe, group, rep, pass, exit: 0, timed_out: false, wall_s: 60, cost_usd: 1,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
  num_turns: 4, tool_calls: 5, search_before_hit: 2, docs_loaded: arm === "A" ? [] : ["AGENTS.md"], budget_hit: false, trap_hits: [], ...o,
});
const triplets = (probe: string, group: GradeRow["group"], reps: number, f: (arm: GradeRow["arm"], rep: number) => Partial<GradeRow> & { pass: boolean }) =>
  Array.from({ length: reps }, (_, i) => (["A", "B", "C"] as const).map((a) => { const { pass, ...o } = f(a, i + 1); return row(a, probe, group, i + 1, pass, o); })).flat();
const fired = (rows: GradeRow[], audit = "") => verdict(rows, audit).fired;
const only = (got: string[], want: string[], what: string) => check(JSON.stringify(got) === JSON.stringify(want), `${what}: fired ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

export const REPORT_CASES: { name: string; fn: (c: Ctx) => Promise<void> }[] = [
  { name: "report: synthetic fixture fires exactly Hierarchy benefit + Detriment: overhead", fn: async () => {
    const { md, fired: f } = renderReport(FIXTURE, "no false claims here");
    only(f, ["Hierarchy benefit", "Detriment: overhead"], "fixture");
    check(md.includes("- **Hierarchy benefit**:") && md.includes("- **Detriment: overhead**:"), "verdict lines missing from report.md");
    check(md.includes("## Verdict") && md.trimEnd().endsWith("Smoke test: n is small; treat as directional."), "verdict section or smoke line missing");
    check(!md.includes("NaN"), "NaN in report");
  } },
  { name: "report: equal zero-search medians are no hierarchy benefit", fn: async () => {
    only(fired(triplets("metal-skip", "child", 2, () => ({ pass: true, search_before_hit: 0 }))), ["Inconclusive"], "zero medians");
  } },
  { name: "report: null search medians are no hierarchy benefit", fn: async () => {
    only(fired(triplets("metal-skip", "child", 2, () => ({ pass: true, search_before_hit: null }))), ["Inconclusive"], "null medians");
    only(fired(triplets("metal-skip", "child", 2, (a) => ({ pass: true, search_before_hit: a === "B" ? null : 3 }))), ["Inconclusive"], "B null median");
  } },
  { name: "report: zero passes fire nothing but Inconclusive", fn: async () => {
    const rows = [...triplets("metal-skip", "child", 2, () => ({ pass: false })), ...triplets("ws-members", "neutral", 2, () => ({ pass: false }))];
    only(fired(rows), ["Inconclusive"], "zero passes");
    check(!renderReport(rows, "").md.includes("NaN"), "NaN in zero-pass report");
  } },
  { name: "report: unmatched or dry-run rows never count toward a benefit", fn: async () => {
    const base = triplets("metal-skip", "child", 1, () => ({ pass: false }));
    const extraB = [2, 3, 4].map((rep) => row("B", "head-dim", "child", rep, true));
    const missingC = [2, 3].flatMap((rep) => [row("A", "splice-memo", "child", rep, false), row("B", "splice-memo", "child", rep, true)]);
    const dry = triplets("seam-test", "child", 3, (a) => ({ pass: a !== "A", ns: "dry-run" }));
    only(fired([...base, ...extraB, ...missingC, ...dry]), ["Inconclusive"], "unmatched rows");
  } },
  { name: "report: doc claim false in keys-audit fires harmful guidance (as in the real audit)", fn: async () => {
    const rows = triplets("metal-skip", "child", 1, () => ({ pass: true }));
    only(fired(rows, "- **new-opcode (doc claim false)**: stale"), ["Detriment: harmful guidance"], "synthetic audit");
    only(fired(rows, readFileSync(join(import.meta.dir, "keys-audit.md"), "utf8")), ["Detriment: harmful guidance"], "real keys-audit.md");
    only(fired(triplets("metal-skip", "child", 1, (a) => ({ pass: true, trap_hits: a === "C" ? ["tool_spans"] : [] }))), ["Detriment: harmful guidance"], "C trap hits");
  } },
  { name: "report: zero rows exit 1 with 'no graded runs'", fn: async (c) => {
    mkdirSync(join(c.out, "matrix"), { recursive: true });
    writeFileSync(join(c.out, "matrix", "grades.json"), "[]");
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "eval.ts"), "report", "--ns", "matrix"], { env: { ...process.env, AMD_EVAL_OUT: c.out }, stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    const code = await p.exited;
    check(code === 1 && out.includes("no graded runs") && !out.includes("NaN"), `exit ${code}\n${out}`);
  } },
];
