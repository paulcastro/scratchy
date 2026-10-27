// `eval.ts report [--ns matrix|dry-run]`: tables plus the pre-registered verdict over ${OUT}/${ns}/grades.json,
// written to ${OUT}/${ns}/report.md and printed. The verdict rules below are hash-pinned (run.ts HASHED_FILES)
// and must not be tuned after results are seen.
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * One grades.json row (grades.json is a JSON array of these). The grader writes every result.json
 * metric through unchanged and adds `group` (from probes.json), `pass` and `trap_hits` (trap names
 * matched in this run, one entry per hit).
 */
export type GradeRow = {
  id?: string; ns: string; model: string; arm: "A" | "B" | "C"; probe: string;
  group: "child" | "root" | "cross" | "neutral"; rep: number; pass: boolean; note?: string;
  exit: number | null; timed_out: boolean; wall_s: number; cost_usd: number | null;
  usage: { input_tokens: number | null; output_tokens: number | null; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null };
  num_turns: number | null; tool_calls: number; search_before_hit: number | null;
  docs_loaded: string[]; budget_hit: boolean; trap_hits: string[];
};

export const VERDICT_RULES = `- All comparative rules use only complete matched \`(probe, rep)\` A/B/C triplets from the \`matrix\` namespace.
- **Hierarchy benefit** if B child-group passes >= C child-group passes + 2, OR (passes equal AND both medians non-null AND C's median search_before_hit on child probes > 0 AND B's <= 0.8 x C's).
- **Content benefit** (docs help, structure irrelevant) if both B and C child-group passes >= A + 2, and the hierarchy-benefit rule does not fire.
- **Detriment: regression** if B root-group passes < A root-group passes - 1.
- **Detriment: overhead** if B's median input tokens on the neutral probe > 1.25 x A's, or if B's cost$/pass across all probes > 1.25 x C's.
- **Detriment: harmful guidance** if B or C trap hits > A's, or keys-audit.md lists any "doc claim false".
- **Inconclusive** if no rule fires.`;

export const RULES = ["Hierarchy benefit", "Content benefit", "Detriment: regression", "Detriment: overhead", "Detriment: harmful guidance", "Inconclusive"] as const;
const ARMS = ["A", "B", "C"] as const;
const SMOKE = "Smoke test: n is small; treat as directional.";

/** "Input tokens" = everything the model read: uncached + cache read + cache creation (docs land in the cache). */
const inputTokens = (r: GradeRow) => {
  const u = r.usage ?? ({} as GradeRow["usage"]);
  const xs = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens];
  return xs.every((x) => x == null) ? null : xs.reduce<number>((a, x) => a + (x ?? 0), 0);
};
const median = (xs: (number | null | undefined)[]) => {
  const s = xs.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const passes = (rs: GradeRow[]) => rs.filter((r) => r.pass).length;
const costPerPass = (rs: GradeRow[]) => (passes(rs) ? rs.reduce((a, r) => a + (r.cost_usd ?? 0), 0) / passes(rs) : null);
const traps = (rs: GradeRow[]) => rs.reduce((a, r) => a + (r.trap_hits?.length ?? 0), 0);
const fmt = (x: number | null, d = 0) => (x == null ? "-" : x.toFixed(d));
const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => " --- ").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

/** Rows from complete (model, probe, rep) A/B/C triplets in the matrix namespace; duplicates make a key incomplete. */
export function matchedTriplets(rows: GradeRow[]): GradeRow[] {
  const by = new Map<string, GradeRow[]>();
  for (const r of rows.filter((r) => r.ns === "matrix")) {
    const k = `${r.model}\0${r.probe}\0${r.rep}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return [...by.values()].filter((g) => g.length === 3 && ARMS.every((a) => g.filter((r) => r.arm === a).length === 1)).flat();
}

export function verdict(rows: GradeRow[], keysAudit: string): { fired: string[]; lines: string[]; triplets: number } {
  const t = matchedTriplets(rows);
  const sel = (arm: string, group?: string) => t.filter((r) => r.arm === arm && (!group || r.group === group));
  const P = (arm: string, group: string) => passes(sel(arm, group));
  const fired: string[] = [], lines: string[] = [];
  const fire = (name: string, why: string) => { fired.push(name); lines.push(`- **${name}**: ${why}`); };

  const [Ac, Bc, Cc] = ARMS.map((a) => P(a, "child"));
  const [mB, mC] = ["B", "C"].map((a) => median(sel(a, "child").map((r) => r.search_before_hit)));
  const hier = Bc >= Cc + 2 || (Bc === Cc && mB != null && mC != null && mC > 0 && mB <= 0.8 * mC);
  if (hier) fire("Hierarchy benefit", `child passes B=${Bc} C=${Cc}; median child search_before_hit B=${fmt(mB, 1)} C=${fmt(mC, 1)}`);
  if (!hier && Bc >= Ac + 2 && Cc >= Ac + 2) fire("Content benefit", `child passes A=${Ac} B=${Bc} C=${Cc}`);

  const [Ar, Br] = ["A", "B"].map((a) => P(a, "root"));
  if (Br < Ar - 1) fire("Detriment: regression", `root passes A=${Ar} B=${Br}`);

  const [tA, tB] = ["A", "B"].map((a) => median(sel(a, "neutral").map(inputTokens)));
  const [cB, cC] = ["B", "C"].map((a) => costPerPass(sel(a)));
  const tok = tA != null && tB != null && tB > 1.25 * tA, cost = cB != null && cC != null && cB > 1.25 * cC;
  if (tok || cost) fire("Detriment: overhead", `median neutral input tokens A=${fmt(tA)} B=${fmt(tB)}; cost$/pass B=${fmt(cB, 3)} C=${fmt(cC, 3)}`);

  const [hA, hB, hC] = ARMS.map((a) => traps(sel(a)));
  const falseClaims = keysAudit.split("\n").filter((l) => /doc claim false/i.test(l)).length;
  if (hB > hA || hC > hA || falseClaims) fire("Detriment: harmful guidance", `trap hits A=${hA} B=${hB} C=${hC}; keys-audit.md "doc claim false" lines=${falseClaims}`);

  if (!fired.length) fire("Inconclusive", "no rule fires");
  return { fired, lines, triplets: t.length / 3 };
}

/** Renders report.md; throws "no graded runs" on an empty grades.json so no NaN tables are printed. */
export function renderReport(rows: GradeRow[], keysAudit: string, probeOrder: string[] = []): { md: string; fired: string[] } {
  if (!rows.length) throw new Error("no graded runs");
  const arms = ARMS.filter((a) => rows.some((r) => r.arm === a));
  const of = (arm: string) => rows.filter((r) => r.arm === arm);
  const t1 = table(
    ["arm", "runs", "pass%", "cost$/pass", "median input tok", "median tool_calls", "median search_before_hit", "median wall_s", "trap hits", "budget_hit", "docs_loaded empty"],
    arms.map((a) => {
      const g = of(a);
      return [a, g.length, (100 * passes(g) / g.length).toFixed(0), fmt(costPerPass(g), 3), fmt(median(g.map(inputTokens))),
        fmt(median(g.map((r) => r.tool_calls)), 1), fmt(median(g.map((r) => r.search_before_hit)), 1), fmt(median(g.map((r) => r.wall_s))),
        traps(g), g.filter((r) => r.budget_hit).length, a === "A" ? "-" : g.filter((r) => !r.docs_loaded?.length).length];
    }),
  );
  const cell = (g: GradeRow[]) => `${passes(g)}/${g.length}`;
  const groups = ["child", "root", "cross", "neutral"].filter((x) => rows.some((r) => r.group === x));
  const t2 = table(["group", ...arms], groups.map((x) => [x, ...arms.map((a) => cell(of(a).filter((r) => r.group === x)))]));
  const probes = [...new Set([...probeOrder.filter((p) => rows.some((r) => r.probe === p)), ...rows.map((r) => r.probe)])];
  const t3 = table(["probe", ...arms], probes.map((p) => [p, ...arms.map((a) => cell(of(a).filter((r) => r.probe === p)))]));
  const trapCounts = new Map<string, number>();
  for (const r of rows) for (const h of r.trap_hits ?? []) trapCounts.set(`${r.arm}\0${h}`, (trapCounts.get(`${r.arm}\0${h}`) ?? 0) + 1);
  const t4 = trapCounts.size
    ? table(["arm", "trap", "hits"], [...trapCounts].sort().map(([k, n]) => [...k.split("\0"), n]))
    : "No trap hits.";

  const v = verdict(rows, keysAudit);
  const md = [
    "# AGENTS.md A/B/C eval report", "",
    `${rows.length} graded run(s); models: ${[...new Set(rows.map((r) => r.model))].join(", ")}; namespaces: ${[...new Set(rows.map((r) => r.ns))].join(", ")}.`, "",
    "## Per arm", "", t1, "", "Input tokens = input + cache_read + cache_creation.", "",
    "## Per group (pass/runs)", "", t2, "",
    "## Per probe (pass/runs)", "", t3, "",
    "## Traps by arm", "", t4, "",
    "## Verdict", "",
    `Computed on ${v.triplets} complete matched (model, probe, rep) A/B/C triplet(s) from the matrix namespace.`, "",
    "Rules (pre-registered):", "", VERDICT_RULES, "",
    "Fired:", "", ...v.lines, "",
    SMOKE,
  ].join("\n");
  return { md, fired: v.fired };
}

export function reportCmd(out: string, ns: string): number {
  const f = join(out, ns, "grades.json");
  if (!existsSync(f)) { console.error(`report: no graded runs (${f} missing)`); return 1; }
  const rows: GradeRow[] = JSON.parse(readFileSync(f, "utf8"));
  const probeOrder = JSON.parse(readFileSync(join(import.meta.dir, "probes.json"), "utf8")).probes.map((p: any) => p.id);
  let md: string;
  try {
    ({ md } = renderReport(rows, readFileSync(join(import.meta.dir, "keys-audit.md"), "utf8"), probeOrder));
  } catch (e: any) {
    console.error(`report: ${e.message} in ${f}`);
    return 1;
  }
  writeFileSync(join(out, ns, "report.md"), md + "\n");
  console.log(md);
  return 0;
}
