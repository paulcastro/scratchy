// `eval.ts selftest` cases for the runner, driven by the fake launcher (AMD_EVAL_FAKE_CLAUDE=1, see
// fake-claude.ts). Each case gets its own throwaway OUT and cleans its worktrees. Todo 4 appends
// grader / trap / detector cases to CASES.
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "fs";
import { join } from "path";
import { claudeVersion, parseEvents } from "./claude";
import { spend } from "./ledger";
import { REPORT_CASES } from "./report-selftest";

const EVAL = join(import.meta.dir, "eval.ts");
type Ctx = { out: string; fakeLog: string };
type Case = { name: string; fn: (c: Ctx) => Promise<void> };

const check = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const fakeEvents = (c: Ctx) => (existsSync(c.fakeLog) ? parseEvents(readFileSync(c.fakeLog, "utf8")) : []);
const launches = (c: Ctx) => fakeEvents(c).filter((e) => e.ev === "start").length;
const maxInFlight = (c: Ctx) => {
  let n = 0, max = 0;
  for (const e of fakeEvents(c).sort((a, b) => a.t - b.t)) { n += e.ev === "start" ? 1 : -1; max = Math.max(max, n); }
  return max;
};
const results = (c: Ctx, ns = "dry-run") =>
  Bun.$`find ${join(c.out, ns, "runs")} -name result.json`.quiet().nothrow().text().then((t) => t.trim().split("\n").filter(Boolean));
const openRids = (c: Ctx) => {
  const ev = parseEvents(readFileSync(join(c.out, "ledger.jsonl"), "utf8"));
  const settled = new Set(ev.filter((e) => e.kind === "settle" && typeof e.cost_usd === "number").map((e) => e.rid));
  return ev.filter((e) => e.kind === "reserve" && !settled.has(e.rid)).map((e) => e.rid);
};

function spawnRun(c: Ctx, args: string[], env: Record<string, string> = {}) {
  return Bun.spawn([process.execPath, EVAL, "run", "--ns", "dry-run", ...args], {
    env: { ...process.env, AMD_EVAL_OUT: c.out, AMD_EVAL_FAKE_CLAUDE: "1", AMD_EVAL_FAKE_LOG: c.fakeLog, AMD_EVAL_FAKE_MS: "300", ...env },
    stdout: "pipe", stderr: "pipe",
  });
}
async function runEval(c: Ctx, args: string[], env: Record<string, string> = {}) {
  const p = spawnRun(c, args, env);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: stdout + stderr };
}

/** Resolves once `f` gains a line matching `pred` (fs.watch on the file, bounded by `ms`). */
function waitForLine(f: string, pred: (lines: any[]) => boolean, ms = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = () => existsSync(f) && pred(parseEvents(readFileSync(f, "utf8")));
    if (ok()) return resolve();
    const w = watch(f, () => { if (ok()) { w.close(); clearTimeout(t); resolve(); } });
    const t = setTimeout(() => { w.close(); reject(new Error(`timeout waiting on ${f}`)); }, ms);
  });
}

const ARGS3 = ["--reps", "1", "--probes", "ws-members", "--arms", "A,B,C"];

export const CASES: Case[] = [
  { name: "cap $2 with 4 jobs keeps at most 2 calls in flight", fn: async (c) => {
    const r = await runEval(c, ["--reps", "1", "--probes", "ws-members,metal-skip", "--arms", "A,B,C", "--jobs", "4"], { AMD_EVAL_CAP_USD: "2", AMD_EVAL_FAKE_MS: "800" });
    check(maxInFlight(c) === 2, `max in flight ${maxInFlight(c)}, want 2\n${r.out}`);
    check(r.out.includes("cap reached: $"), `no 'cap reached'\n${r.out}`);
    check(spend(join(c.out, "ledger.jsonl")).total <= 2 + 1e-9, "ledger total above cap");
  } },
  { name: "cap $0.01 launches nothing and prints cap reached", fn: async (c) => {
    const r = await runEval(c, ARGS3, { AMD_EVAL_CAP_USD: "0.01" });
    check(launches(c) === 0, `${launches(c)} launches`);
    check(r.out.includes("cap reached: $"), `no 'cap reached'\n${r.out}`);
    check(!existsSync(`${c.out}-wt`), "a worktree was created");
  } },
  { name: "resume never duplicates settled calls", fn: async (c) => {
    await runEval(c, ARGS3);
    check(launches(c) === 3, `first pass ${launches(c)} launches`);
    const r = await runEval(c, ARGS3);
    check(launches(c) === 3 && r.out.includes("3 resumed"), `resume relaunched\n${r.out}`);
    await runEval(c, ["--reps", "2", "--probes", "ws-members", "--arms", "A,B,C"]);
    check(launches(c) === 6 && (await results(c)).length === 6, `reps 2: ${launches(c)} launches`);
  } },
  { name: "an unresolved reservation is never released", fn: async (c) => {
    writeFileSync(join(c.out, "ledger.jsonl"), JSON.stringify({ kind: "reserve", rid: "orphan", usd: 1 }) + "\n");
    const r = await runEval(c, ARGS3, { AMD_EVAL_CAP_USD: "1.5" });
    check(launches(c) === 0 && r.out.includes("cap reached"), `orphan reservation not counted\n${r.out}`);
    await runEval(c, ARGS3, { AMD_EVAL_CAP_USD: "10" });
    check(openRids(c).join() === "orphan", `open reservations ${openRids(c)}`);
    check(Math.abs(spend(join(c.out, "ledger.jsonl")).total - (1 + 3 * 0.4)) < 1e-9, "ledger total wrong");
  } },
  { name: "hung call is killed at the timeout and keeps its reservation", fn: async (c) => {
    const r = await runEval(c, ["--reps", "1", "--probes", "ws-members", "--arms", "A"], { AMD_EVAL_FAKE_HANG: "1", AMD_EVAL_RUN_TIMEOUT_MS: "1500" });
    const [f] = await results(c);
    const res = JSON.parse(readFileSync(f, "utf8"));
    check(res.timed_out === true && res.cost_usd === null && res.exit !== 0, `result ${JSON.stringify(res)}`);
    check(r.out.includes("1 timed out"), `summary hides the timeout\n${r.out}`);
    check(openRids(c).length === 1, "timed-out reservation released");
    const left = await $`pgrep -f "sleep 600"`.quiet().nothrow();
    check(left.exitCode !== 0, `hung grandchild survived: ${left.stdout}`);
  } },
  { name: "budget_hit and nonzero exit are recorded, not hidden", fn: async (c) => {
    const r = await runEval(c, ["--reps", "1", "--probes", "ws-members", "--arms", "A"], { AMD_EVAL_FAKE_BUDGET: "1" });
    const res = JSON.parse(readFileSync((await results(c))[0], "utf8"));
    check(res.budget_hit === true && res.exit === 1 && res.result_subtype === "error_max_budget_usd", `result ${JSON.stringify(res)}`);
    check(r.out.includes("BUDGET_HIT") && r.out.includes("1 nonzero exit") && r.out.includes("1 budget_hit"), `summary hides it\n${r.out}`);
  } },
  { name: "metrics: usage, docs_loaded, search_before_hit", fn: async (c) => {
    await runEval(c, ["--reps", "1", "--probes", "ws-members,metal-skip", "--arms", "B"]);
    const rs = await Promise.all((await results(c)).map(async (f) => JSON.parse(readFileSync(f, "utf8"))));
    const ws = rs.find((r) => r.probe === "ws-members"), ms = rs.find((r) => r.probe === "metal-skip");
    check(ws.usage.input_tokens === 10 && ws.usage.cache_creation_input_tokens === 40 && ws.cost_usd === 0.4 && ws.num_turns === 4 && ws.tool_calls === 3, `metrics ${JSON.stringify(ws)}`);
    check(JSON.stringify(ws.docs_loaded) === '["AGENTS.md"]', `docs_loaded ${JSON.stringify(ws.docs_loaded)}`);
    check(ws.search_before_hit === 2 && ms.search_before_hit === 2, `search_before_hit ${ws.search_before_hit}/${ms.search_before_hit}`);
  } },
  { name: "SIGINT mid-run then resume: no duplicates, open reservation kept", fn: async (c) => {
    const p = spawnRun(c, [...ARGS3, "--jobs", "1"], { AMD_EVAL_FAKE_MS: "2000" });
    writeFileSync(c.fakeLog, "");
    await waitForLine(c.fakeLog, (ls) => ls.filter((e) => e.ev === "start").length === 2);
    p.kill("SIGINT");
    const code = await p.exited;
    check(code === 130, `exit ${code} after SIGINT`);
    check((await results(c)).length === 1 && openRids(c).length === 1, `after SIGINT: ${(await results(c)).length} results, ${openRids(c).length} open`);
    const interrupted = openRids(c)[0];
    await runEval(c, [...ARGS3, "--jobs", "1"], { AMD_EVAL_FAKE_MS: "300" });
    check(launches(c) === 4 && (await results(c)).length === 3, `resume: ${launches(c)} launches, want 4 (2 + 2 remaining)`);
    check(openRids(c).join() === interrupted, "interrupted reservation released");
  } },
  { name: "manifest hash mismatch makes run refuse", fn: async (c) => {
    await runEval(c, ["--reps", "1", "--probes", "ws-members", "--arms", "A"]);
    const [f] = await results(c);
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), manifest_hash: "stale" }));
    const r = await runEval(c, ["--reps", "1", "--probes", "ws-members", "--arms", "A,B"]);
    check(r.code === 1 && r.out.includes("manifest mismatch") && launches(c) === 1, `exit ${r.code}\n${r.out}`);
  } },
];

CASES.push(...REPORT_CASES);

export async function selftest(): Promise<number> {
  const version = await claudeVersion();
  let failed = 0;
  for (const [i, k] of CASES.entries()) {
    const out = `/tmp/amd-selftest-${process.pid}-${i}`;
    const c: Ctx = { out, fakeLog: join(out, "fake.log") };
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "preflight.json"), JSON.stringify({ ok: true, claude_version: version, arms: {} }));
    try {
      await k.fn(c);
      console.log(`ok   ${k.name}`);
    } catch (e: any) {
      failed++;
      console.log(`FAIL ${k.name}: ${e.message}`);
    } finally {
      await $`${process.execPath} ${EVAL} clean`.env({ ...process.env, AMD_EVAL_OUT: out }).quiet().nothrow();
      rmSync(out, { recursive: true, force: true });
      rmSync(`${out}-wt`, { recursive: true, force: true });
    }
  }
  console.log(`selftest: ${CASES.length - failed}/${CASES.length} runner cases ok`);
  return failed ? 1 : 0;
}
