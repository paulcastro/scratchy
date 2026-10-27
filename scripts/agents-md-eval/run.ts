// `eval.ts run`: graded matrix calls with resume, the reservation spend cap and metrics capture.
//
// Usage field names (verified on .omo/evidence/task-2-transcripts/B-P1.jsonl, claude 2.1.309):
// the final `{"type":"result"}` event carries `total_cost_usd`, `num_turns`, `subtype`
// ("success" | "error_max_budget_usd" | ...), `result` (final text) and
// `usage: {input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`;
// the `{"type":"system","subtype":"init"}` event carries the resolved `model` (e.g. "aws/claude-sonnet-5").
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { ARMS, materialize, resolveCommit, type Arm } from "./arms";
import { claudeVersion, docsLoaded, loadsFromHookLog, parseEvents, runClaude, writeSettings } from "./claude";
import { reserve, settleUnlaunched, spend } from "./ledger";

const REPO = join(import.meta.dir, "../..");
const RUN_TIMEOUT_MS = Number(process.env.AMD_EVAL_RUN_TIMEOUT_MS ?? 900_000);
// Files whose content defines what a result means; any change invalidates resume. Todos 4/6 add grader/verdict files.
export const HASHED_FILES = ["probes.json", "arms.ts", "claude.ts", "run.ts", "report.ts"];

export type RunOpts = {
  out: string; base: string; docsRef: string; ns: string; model: string; reps: number; jobs: number;
  arms: Arm[]; probes: string[] | null; addWorktree: (wt: string) => void;
};

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const cmdOut = async (c: string[]) => (await $`${c}`.quiet().nothrow().text()).trim() || null;

async function identity(o: RunOpts) {
  const pf = JSON.parse(readFileSync(join(o.out, "preflight.json"), "utf8"));
  const pfTranscript = pf.arms?.A?.P0?.transcript;
  const resolved = o.model === "sonnet" && pfTranscript && existsSync(pfTranscript)
    ? parseEvents(readFileSync(pfTranscript, "utf8")).find((e) => e.type === "system" && e.subtype === "init")?.model ?? null
    : null;
  const files = Object.fromEntries(HASHED_FILES.map((f) => [f, sha256(readFileSync(join(import.meta.dir, f), "utf8"))]));
  return {
    base: await resolveCommit(o.base), docs: await resolveCommit(o.docsRef), model: o.model, model_resolved: resolved,
    claude_version: await claudeVersion(), bun_version: Bun.version, rustc_version: await cmdOut(["rustc", "--version"]),
    files,
  };
}

const answerPrompt = (p: any) => `${p.prompt}\n\nEnd your reply with exactly one line in this format:\n${p.answer_format}`;

/** Grep/Glob/Bash-search tool uses before the first Read/Edit under scope_dir; null when nothing in scope was read. */
export function searchBeforeHit(toolUses: any[], roots: string[], scopeDir: string): number | null {
  const scopes = roots.map((r) => (scopeDir === "." ? r : join(r, scopeDir)));
  const inScope = (f: unknown) => typeof f === "string" && scopes.some((s) => f === s || f.startsWith(s + "/") || (!f.startsWith("/") && scopeDir === "."));
  let n = 0;
  for (const t of toolUses) {
    if ((t.name === "Read" || t.name === "Edit") && inScope(t.input?.file_path)) return n;
    if (t.name === "Grep" || t.name === "Glob" || (t.name === "Bash" && /(^|[\s|;&(])(rg|grep|find|ls)\b/.test(String(t.input?.command ?? "")))) n++;
  }
  return null;
}

export async function run(o: RunOpts): Promise<number> {
  const cap = Number(process.env.AMD_EVAL_CAP_USD ?? 150);
  const ledger = join(o.out, "ledger.jsonl");
  const allProbes: any[] = JSON.parse(readFileSync(join(import.meta.dir, "probes.json"), "utf8")).probes;
  const unknown = (o.probes ?? []).filter((id) => !allProbes.some((p) => p.id === id));
  if (unknown.length) { console.error(`unknown probe id(s): ${unknown.join(", ")}`); return 1; }
  const probes = o.probes ? allProbes.filter((p) => o.probes!.includes(p.id)) : allProbes;

  const id = await identity(o);
  const hash = sha256(JSON.stringify(id));
  const mf = join(o.out, "manifest.json");
  const prev = existsSync(mf) ? JSON.parse(readFileSync(mf, "utf8")) : { worktrees: [] };
  writeFileSync(mf, JSON.stringify({ ...prev, ...id, manifest_hash: hash, worktrees: prev.worktrees ?? [] }, null, 2));

  const runsDir = join(o.out, o.ns, "runs");
  const existing = existsSync(runsDir) ? (await $`find ${runsDir} -name result.json`.quiet().text()).trim().split("\n").filter(Boolean) : [];
  const stale = existing.filter((f) => JSON.parse(readFileSync(f, "utf8")).manifest_hash !== hash);
  if (stale.length) {
    console.error(`run refused: ${stale.length} result.json under ${runsDir} have a manifest hash other than ${hash.slice(0, 12)} (manifest mismatch; e.g. ${stale[0]}). Use a new --ns or AMD_EVAL_OUT.`);
    return 1;
  }

  const settings = writeSettings(o.out);
  type Job = { rep: number; probe: any; arm: Arm };
  const jobs: Job[] = [];
  for (let rep = 1; rep <= o.reps; rep++) for (const probe of probes) for (const arm of o.arms) jobs.push({ rep, probe, arm });

  let inflight = 0, capHit = false, next = 0, launched = 0, skipped = 0;
  let waiters: (() => void)[] = [];
  const done = () => { inflight--; const w = waiters; waiters = []; w.forEach((f) => f()); };
  const tally = { nonzero: 0, timed_out: 0, budget_hit: 0 };

  const runOne = async ({ rep, probe, arm }: Job) => {
    const rid0 = `${o.model}/${arm}/${probe.id}/${rep}`;
    const dir = join(runsDir, rid0);
    if (existsSync(join(dir, "result.json"))) { skipped++; return; }
    const wt = join(`${o.out}-wt`, `${o.ns}_${rid0.replaceAll("/", "_")}`);
    let rid: string | null;
    const meta = { ns: o.ns, run: rid0, model: o.model, arm, probe: probe.id, rep };
    while (!(rid = capHit ? null : reserve(ledger, cap, meta))) {
      if (capHit || inflight === 0) { capHit = true; return; }
      await new Promise<void>((r) => waiters.push(r));
    }
    inflight++;
    try {
      try {
        // A leftover worktree from an interrupted run is replaced, never reused.
        await $`git -C ${REPO} worktree remove --force ${wt}`.quiet().nothrow();
        await $`rm -rf ${wt}`.quiet();
        await $`git -C ${REPO} worktree add --detach --force ${wt} ${id.base}`.quiet();
        o.addWorktree(wt);
        await materialize(arm, wt, id.docs);
      } catch (e) {
        settleUnlaunched(ledger, rid, meta);
        throw e;
      }
      launched++;
      mkdirSync(dir, { recursive: true });
      const call = await runClaude({
        prompt: answerPrompt(probe), wt, stem: join(dir, "transcript"), settings, model: o.model, ledger, rid,
        ledgerExtra: meta, timeoutMs: RUN_TIMEOUT_MS, env: { CARGO_TARGET_DIR: join(o.out, "cargo-target", arm) },
      });
      const events = parseEvents(readFileSync(call.transcript, "utf8"));
      const toolUses = events.filter((e) => e.type === "assistant").flatMap((e) => e.message?.content ?? []).filter((c: any) => c.type === "tool_use");
      const roots = [...new Set([wt, realpathSync(wt)])];
      const u = call.result?.usage ?? {};
      const num = (v: unknown) => (typeof v === "number" ? v : null);
      const res = {
        id: rid0, ns: o.ns, model: o.model, model_resolved: events.find((e) => e.type === "system" && e.subtype === "init")?.model ?? null,
        arm, probe: probe.id, rep, manifest_hash: hash,
        exit: call.exit, timed_out: call.timed_out, wall_s: call.wall_s, cost_usd: call.cost_usd,
        usage: {
          input_tokens: num(u.input_tokens), output_tokens: num(u.output_tokens),
          cache_read_input_tokens: num(u.cache_read_input_tokens), cache_creation_input_tokens: num(u.cache_creation_input_tokens),
        },
        num_turns: num(call.result?.num_turns), tool_calls: toolUses.length,
        search_before_hit: searchBeforeHit(toolUses, roots, probe.scope_dir),
        docs_loaded: docsLoaded(loadsFromHookLog(readFileSync(call.loaded_log, "utf8"), realpathSync(wt))),
        budget_hit: /budget/i.test(String(call.result?.subtype ?? "")) || /budget/i.test(call.stderr),
        result_subtype: call.result?.subtype ?? null,
        final: String(call.result?.result ?? ""), stderr: call.stderr.slice(-2000), wt,
      };
      writeFileSync(join(dir, "result.json"), JSON.stringify(res, null, 2));
      if (res.exit !== 0) tally.nonzero++;
      if (res.timed_out) tally.timed_out++;
      if (res.budget_hit) tally.budget_hit++;
      console.log(`${o.ns}/${rid0} exit=${res.exit}${res.timed_out ? " TIMED_OUT" : ""}${res.budget_hit ? " BUDGET_HIT" : ""} ${res.wall_s.toFixed(0)}s $${res.cost_usd?.toFixed(3) ?? "?"}`);
    } finally {
      done();
    }
  };

  const errors: string[] = [];
  await Promise.all(Array.from({ length: Math.max(1, o.jobs) }, async () => {
    while (!capHit && next < jobs.length) {
      const j = jobs[next++];
      await runOne(j).catch((e) => { errors.push(`${j.arm}/${j.probe.id}/${j.rep}: ${e.message ?? e}`); console.error(`run error ${j.arm}/${j.probe.id}/${j.rep}:`, e.message ?? e); });
    }
  }));

  const s = spend(ledger);
  if (capHit) console.log(`cap reached: $${s.total.toFixed(2)} (settled $${s.settled.toFixed(2)} + open reservations $${s.open.toFixed(2)}) of cap $${cap}`);
  console.log(`run ${o.ns}: ${jobs.length} job(s), ${launched} launched, ${skipped} resumed, ${tally.nonzero} nonzero exit, ${tally.timed_out} timed out, ${tally.budget_hit} budget_hit, ${errors.length} harness error(s); ledger $${s.settled.toFixed(2)} settled + $${s.open.toFixed(2)} open`);
  return errors.length ? 1 : capHit ? 3 : 0;
}
