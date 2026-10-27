// `eval.ts preflight`: proves each arm's docs reach Claude Code before any graded run counts.
// Canaries live only in throwaway preflight worktrees; detection is the InstructionsLoaded hook log
// (see claude.ts), never assistant text. Assistant mentions are recorded as `model_reported` for
// context only and play no part in `ok`.
import { $ } from "bun";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { ARMS, docList, materialize, resolveCommit, type Arm } from "./arms";
import { claudeVersion, docsLoaded, loadsFromHookLog, parseEvents, runClaude, writeSettings } from "./claude";

const REPO = join(import.meta.dir, "../..");
const ASK = "list every token in your context that starts with CANARY-.";
export const PROMPTS = {
  P0: `Without using any tools, ${ASK}`,
  P1: `Read crates/targets/metal/src/lib.rs lines 290-300, then ${ASK}`,
  P2: `Read crates/triton/splice/src/lib.rs lines 2565-2575, then ${ASK}`,
} as const;
type P = keyof typeof PROMPTS;
const NESTED: Partial<Record<P, string>> = { P1: "crates/targets/metal/AGENTS.md", P2: "crates/triton/splice/AGENTS.md" };
const AUDIT = ["crates/targets/metal/src/lib.rs", "crates/triton/splice/src/lib.rs", "CLAUDE.md", "crates/models/arch/dsl/CLAUDE.md"];

const isAgents = (p: string) => /(^|\/)AGENTS\.md$/.test(p);

export function readPreflight(out: string): any | null {
  const f = join(out, "preflight.json");
  try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; } catch { return null; }
}

export async function preflightGate(out: string): Promise<string | null> {
  const pf = readPreflight(out);
  if (!pf) return `preflight not ok: ${join(out, "preflight.json")} missing or unreadable`;
  if (pf.ok !== true) return `preflight not ok: ${join(out, "preflight.json")} has ok=${pf.ok}`;
  const v = await claudeVersion();
  if (pf.claude_version !== v) return `preflight not ok: recorded for claude '${pf.claude_version}', current is '${v}'`;
  return null;
}

const ledgerSpent = (ledger: string) =>
  existsSync(ledger) ? parseEvents(readFileSync(ledger, "utf8")).reduce((s, e) => s + (e.cost_usd ?? 1), 0) : 0;

export async function preflight(o: { out: string; base: string; docsRef: string; addWorktree: (wt: string) => void; dropWorktree: (wt: string) => void }): Promise<number> {
  const { out } = o;
  const baseSha = await resolveCommit(o.base);
  const docsSha = await resolveCommit(o.docsRef);
  const docs = await docList(docsSha);
  for (const p of AUDIT) {
    const r = await $`git -C ${REPO} cat-file -e ${`${baseSha}:${p}`}`.quiet().nothrow();
    if (r.exitCode !== 0) throw new Error(`path audit: ${p} missing at BASE ${baseSha}`);
  }
  for (const p of ["AGENTS.md", ...Object.values(NESTED)]) if (!docs.includes(p!)) throw new Error(`path audit: ${p} missing at DOCS ${docsSha}`);

  const version = await claudeVersion();
  const cap = Number(process.env.AMD_EVAL_CAP_USD ?? 150);
  const ledger = join(out, "ledger.jsonl");
  const dir = join(out, "preflight");
  mkdirSync(dir, { recursive: true });
  const settings = writeSettings(out);
  const noShim = process.env.AMD_EVAL_FORCE_NO_SHIM === "1";

  const armResult = async (arm: Arm) => {
    const wt = `${out}-wt/preflight-${arm}`;
    await $`git -C ${REPO} worktree add --detach --force ${wt} ${baseSha}`.quiet();
    o.addWorktree(wt);
    try {
      await materialize(arm, wt, docsSha);
      const files = arm === "A" ? ["CLAUDE.md", "crates/models/arch/dsl/CLAUDE.md"] : arm === "B" ? docs : ["AGENTS.md"];
      const canaryOf = new Map(files.map((f, n) => [f, `CANARY-${arm}-${n}`]));
      for (const [f, c] of canaryOf) appendFileSync(join(wt, f), `\nPreflight marker: ${c}\n`);
      const real = realpathSync(wt);
      const res: Record<string, unknown> = { worktree: wt, canary_files: Object.fromEntries(canaryOf) };
      for (const p of Object.keys(PROMPTS) as P[]) {
        if (ledgerSpent(ledger) + 1 > cap) throw new Error(`cap reached: $${ledgerSpent(ledger).toFixed(2)} of $${cap}`);
        const call = await runClaude({
          prompt: PROMPTS[p], wt, stem: join(dir, `${arm}-${p}`), settings, ledger,
          ledgerExtra: { ns: "preflight", arm, prompt: p, no_shim: noShim },
        });
        const logLines = readFileSync(call.loaded_log, "utf8").split("\n");
        const loads = loadsFromHookLog(logLines.join("\n"), real);
        const canaries = loads.filter((l) => canaryOf.has(l.path)).map((l) => ({
          canary: canaryOf.get(l.path)!, file: l.path,
          location: {
            source: "InstructionsLoaded hook", log: call.loaded_log, load_reason: l.load_reason,
            line: logLines.findIndex((x) => x.includes(`"file_path":"${join(real, l.path)}"`)) + 1,
            ...(l.parent ? { parent: l.parent } : {}),
          },
        }));
        const text = String(call.result?.result ?? "");
        const loaded = docsLoaded(loads);
        res[p] = {
          exit: call.exit, timed_out: call.timed_out, cost_usd: call.cost_usd, transcript: call.transcript,
          loads, docs_loaded: loaded,
          claude_md_loaded: [...new Set(loads.map((l) => l.path).filter((x) => /(^|\/)CLAUDE\.md$/.test(x)))].sort(),
          canaries, agents_canaries: canaries.filter((c) => isAgents(c.file)).map((c) => c.canary),
          nested_hit: NESTED[p] !== undefined && arm === "B" && loaded.includes(NESTED[p]!),
          model_reported: [...new Set(text.match(/CANARY-[A-C]-\d+/g) ?? [])].sort(),
        };
      }
      return res;
    } finally {
      await $`git -C ${REPO} worktree remove --force ${wt}`.quiet().nothrow();
      o.dropWorktree(wt);
    }
  };

  const results = await Promise.all(ARMS.map(armResult));
  const arms: Record<string, any> = Object.fromEntries(ARMS.map((a, i) => [a, results[i]]));
  const A = arms.A, B = arms.B, C = arms.C;
  A.agents_canaries = [...new Set((["P0", "P1", "P2"] as P[]).flatMap((p) => A[p].agents_canaries))];
  const failures: string[] = [];
  for (const a of ARMS) for (const p of Object.keys(PROMPTS) as P[]) {
    const r = arms[a][p];
    if (r.exit !== 0 || r.timed_out) failures.push(`${a}-${p}: claude exit=${r.exit} timed_out=${r.timed_out}`);
  }
  if (!B.P0.docs_loaded.includes("AGENTS.md")) failures.push(`B-P0: root AGENTS.md canary ${B.canary_files["AGENTS.md"]} not loaded`);
  for (const p of ["P1", "P2"] as P[])
    if (!B[p].nested_hit) failures.push(`B-${p}: nested canary ${B.canary_files[NESTED[p]!]} (${NESTED[p]}) not loaded`);
  if (!C.P0.docs_loaded.includes("AGENTS.md")) failures.push(`C-P0: C canary ${C.canary_files["AGENTS.md"]} not loaded`);
  if (!(["P0", "P1", "P2"] as P[]).every((p) => A[p].claude_md_loaded.includes("CLAUDE.md"))) failures.push("A: root CLAUDE.md did not load");
  if (A.agents_canaries.length) failures.push(`A: AGENTS.md canaries loaded: ${A.agents_canaries.join(",")}`);

  const total = (["A", "B", "C"] as const).flatMap((a) => (["P0", "P1", "P2"] as P[]).map((p) => arms[a][p].cost_usd ?? 0)).reduce((x, y) => x + y, 0);
  const report = {
    ok: failures.length === 0, claude_version: version, base: baseSha, docs: docsSha, force_no_shim: noShim,
    detector: "InstructionsLoaded hook (https://code.claude.com/docs/en/hooks.md#instructionsloaded)",
    failures, cost_usd: total, created: new Date().toISOString(), arms,
  };
  writeFileSync(join(out, "preflight.json"), JSON.stringify(report, null, 2));
  console.log(`preflight ${report.ok ? "ok" : "FAILED"} (claude ${version}, $${total.toFixed(3)}) -> ${join(out, "preflight.json")}`);
  for (const f of failures) console.error(`  ${f}`);
  return report.ok ? 0 : 1;
}
