#!/usr/bin/env bun
// A/B/C eval of the scratchy-perf skill with headless Claude Code.
//   bun scripts/skill-eval/eval.ts run   [--model haiku] [--reps 3] [--jobs 6] [--arms A,B,C] [--probes id,id]
//   bun scripts/skill-eval/eval.ts grade
//   bun scripts/skill-eval/eval.ts report
// Arms: A = upstream main as is; B = main + .claude/skills/scratchy-perf;
//       C = main + the skill's body pasted at the top of the prompt ("plan section").
// Every run gets its own detached worktree of BASE so no run sees another's edits
// or this eval's answer keys.
import { $ } from "bun";
import { parseArgs } from "util";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync } from "fs";
import { join } from "path";

const HERE = import.meta.dir;
const REPO = join(HERE, "../..");
const OUT = process.env.SKILL_EVAL_OUT ?? "/tmp/scratchy-skill-eval";
const BASE = process.env.SKILL_EVAL_BASE ?? "upstream/main";
const RESULT_JSON = "site/data/metal/apple-m4-max-2026-10-13T221900Z-2683d8c3.json";
const SKILL = join(REPO, ".claude/skills/scratchy-perf/SKILL.md");
const probes: any[] = JSON.parse(readFileSync(join(HERE, "probes.json"), "utf8"));

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string", default: "haiku" },
    reps: { type: "string", default: "3" },
    jobs: { type: "string", default: "6" },
    arms: { type: "string", default: "A,B,C" },
    probes: { type: "string" },
  },
});
const cmd = positionals[0];

const skillBody = () => readFileSync(SKILL, "utf8").replace(/^---[\s\S]*?---\n/, "");

function promptFor(p: any, arm: string) {
  const ask = `${p.prompt}\n\nEnd your reply with exactly one line in this format:\n${p.answer_format}`;
  return arm === "C" ? `## Shared context for perf work on this repo\n\n${skillBody()}\n\n## Task\n\n${ask}` : ask;
}

async function runOne(p: any, arm: string, rep: number, model: string) {
  const id = `${model}/${arm}/${p.id}/${rep}`;
  const dir = join(OUT, "runs", id);
  if (existsSync(join(dir, "result.json"))) return;
  mkdirSync(dir, { recursive: true });
  const wt = join(`${OUT}-wt`, id.replaceAll("/", "_"));
  await $`git -C ${REPO} worktree add --detach --force ${wt} ${BASE}`.quiet();
  if (arm === "B") cpSync(join(REPO, ".claude/skills/scratchy-perf"), join(wt, ".claude/skills/scratchy-perf"), { recursive: true });
  const t0 = Date.now();
  const proc = Bun.spawn(
    ["claude", "-p", promptFor(p, arm), "--model", model, "--output-format", "stream-json", "--verbose",
     "--dangerously-skip-permissions", "--no-session-persistence", "--max-budget-usd", "2"],
    { cwd: wt, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, CARGO_TARGET_DIR: join(OUT, "cargo-target", arm) } },
  );
  const timer = setTimeout(() => proc.kill(), 15 * 60_000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  writeFileSync(join(dir, "transcript.jsonl"), stdout);
  const events = stdout.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const res = events.findLast((e) => e.type === "result") ?? {};
  const toolCalls = events.filter((e) => e.type === "assistant")
    .flatMap((e) => e.message?.content ?? []).filter((c: any) => c.type === "tool_use");
  const skillUsed = toolCalls.some((c: any) => c.name === "Skill" && JSON.stringify(c.input).includes("scratchy-perf"))
    || toolCalls.some((c: any) => JSON.stringify(c.input).includes("skills/scratchy-perf"));
  writeFileSync(join(dir, "result.json"), JSON.stringify({
    id, model, arm, probe: p.id, rep, exit: code, stderr: stderr.slice(-2000), wt,
    wall_s: (Date.now() - t0) / 1000, cost_usd: res.total_cost_usd ?? null, turns: res.num_turns ?? null,
    tool_calls: toolCalls.length, skill_used: skillUsed, final: res.result ?? "",
  }, null, 2));
  console.log(`${id} exit=${code} ${((Date.now() - t0) / 1000).toFixed(0)}s $${res.total_cost_usd?.toFixed?.(3)}`);
}

async function run() {
  const arms = o.arms!.split(","), reps = +o.reps!, model = o.model!;
  const sel = o.probes ? probes.filter((p) => o.probes!.split(",").includes(p.id)) : probes;
  const jobs: (() => Promise<void>)[] = [];
  for (let r = 1; r <= reps; r++) for (const p of sel) for (const a of arms) jobs.push(() => runOne(p, a, r, model));
  let next = 0;
  await Promise.all(Array.from({ length: +o.jobs! }, async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      try { await j(); } catch (e) { console.error("run error:", e); }
    }
  }));
}

const answerLine = (s: string) => (s.match(/^.*ANSWER:.*$/gm) ?? []).at(-1) ?? "";
const num = (line: string, k: string) => { const m = line.match(new RegExp(`${k}\\s*=\\s*~?([0-9][0-9,]*\\.?[0-9]*)`)); return m ? +m[1].replaceAll(",", "") : NaN; };

function agentText(transcript: string) {
  return transcript.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    .filter((e) => e.type === "assistant").flatMap((e) => e.message?.content ?? [])
    .map((c: any) => c.type === "text" ? c.text : c.type === "tool_use" ? JSON.stringify(c.input) : "").join("\n");
}
const TRAPS: Record<string, RegExp> = {
  repo_commit: /\.repo\.commit\b|"commit"\s*\]/,
  wrong_crate: /-p\s+scratchy-scheduler\b/,
  unscoped_build: /model\/all\b|features[ =][^\n"]*model\/(llama|qwen|gemma|granite)\b(?!-)/,
  spec_path_as_normal: /ANSWER:\s*`?(self\.)?forward_argmax_blocking\b/,
  ran_bench: /"command":"[^"]*bench_metal_matrix\.sh [^"]*--models/,
};

async function grade() {
  const rows: any[] = [];
  const tampered = join(OUT, "tampered.json");
  const src = JSON.parse(readFileSync(join(REPO, RESULT_JSON), "utf8"));
  src.repo.dirty = true;
  writeFileSync(tampered, JSON.stringify(src));
  for (const f of (await $`find ${join(OUT, "runs")} -name result.json`.text()).trim().split("\n").filter(Boolean)) {
    const r = JSON.parse(readFileSync(f, "utf8"));
    const p = probes.find((x) => x.id === r.probe);
    const line = answerLine(r.final);
    const c = p.check;
    let pass = false, note = "";
    if (c.type === "numbers") {
      pass = Object.entries(c.keys).every(([k, v]: any) => Math.abs(num(line, k) - v) <= v * c.rel_tol);
    } else if (c.type === "numbers_any") {
      const v = parseFloat(line.replace(/^.*ANSWER:\s*/, ""));
      pass = Math.abs(v - c.value) <= c.abs_tol;
    } else if (c.type === "regex_all") {
      const miss = c.patterns.filter((re: string) => !new RegExp(re.replace(/^\(\?i\)/, ""), re.startsWith("(?i)") ? "i" : "").test(re.includes("PREREQ") || re.includes("ANSWER") ? line : r.final));
      pass = miss.length === 0; note = miss.join(" | ");
    } else if (c.type === "shell") {
      const jq = line.replace(/^.*ANSWER:\s*/, "").replace(/^`+|`+$/g, "").trim();
      const ok = await $`bash -c ${jq}`.cwd(r.wt).nothrow().quiet();
      const bad = await $`bash -c ${jq.replaceAll(RESULT_JSON, tampered)}`.cwd(r.wt).nothrow().quiet();
      pass = ok.exitCode === 0 && ok.stdout.toString().trim().replace(/"/g, "") === c.expect_stdout && bad.exitCode !== 0 && jq.includes(RESULT_JSON);
      note = `ok=${ok.exitCode} bad=${bad.exitCode}`;
    } else if (c.type === "cargo_test") {
      const t = await $`cargo test -q -p scratchy-serving-scheduler --lib ${c.test}`.cwd(r.wt)
        .env({ ...process.env, CARGO_TARGET_DIR: join(OUT, "cargo-target", "grade") }).nothrow().quiet();
      const out = t.stdout.toString();
      const diff = (await $`git diff`.cwd(r.wt).quiet()).stdout.toString();
      pass = t.exitCode === 0 && /test result: ok\. 1 passed/.test(out) && diff.includes("2041");
      note = `exit=${t.exitCode}`;
    } else if (c.type === "judge") {
      const prompt = `Grade this answer against the rubric. Rubric: ${c.rubric}\n\nAnswer:\n${r.final.slice(-6000)}`;
      const j = await judge(prompt);
      pass = !j.trap && j.grounded; note = JSON.stringify(j);
    }
    const text = agentText(readFileSync(f.replace("result.json", "transcript.jsonl"), "utf8"));
    const traps = Object.entries(TRAPS).filter(([, re]) => re.test(text)).map(([k]) => k);
    rows.push({ ...r, final: undefined, stderr: undefined, pass, note, traps });
  }
  writeFileSync(join(OUT, "grades.json"), JSON.stringify(rows, null, 2));
  console.log(`graded ${rows.length} runs -> ${join(OUT, "grades.json")}`);
}

async function judge(prompt: string): Promise<{ trap: boolean; grounded: boolean; why: string }> {
  const t = await $`claude -p ${prompt + '\n\nReply with ONLY a JSON object: {"trap": bool, "grounded": bool, "why": "<one sentence>"}'} --model sonnet --output-format json --no-session-persistence --tools ""`.cwd("/tmp").nothrow().quiet();
  try { return JSON.parse(JSON.parse(t.stdout.toString()).result.match(/\{[\s\S]*\}/)[0]); }
  catch { return { trap: false, grounded: false, why: "judge parse error" }; }
}

function report() {
  const rows: any[] = JSON.parse(readFileSync(join(OUT, "grades.json"), "utf8"));
  const groups = new Map<string, any[]>();
  for (const r of rows) { const k = `${r.model}/${r.arm}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const med = (xs: number[]) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const sum = (xs: number[]) => xs.reduce((a, b) => a + (b ?? 0), 0);
  console.log("model/arm   runs  pass%  cost$/pass  median_s  median_tools  trap_hits  skill_used");
  for (const [k, g] of [...groups].sort()) {
    const passes = g.filter((r) => r.pass).length;
    console.log(`${k.padEnd(11)} ${String(g.length).padStart(4)}  ${(100 * passes / g.length).toFixed(0).padStart(5)}  ${(sum(g.map((r) => r.cost_usd)) / Math.max(passes, 1)).toFixed(3).padStart(10)}  ${med(g.map((r) => r.wall_s)).toFixed(0).padStart(8)}  ${String(med(g.map((r) => r.tool_calls))).padStart(12)}  ${String(sum(g.map((r) => r.traps.length))).padStart(9)}  ${g.filter((r) => r.skill_used).length}/${g.length}`);
  }
  console.log("\nper-probe pass counts (model/arm: pass/runs)");
  for (const p of probes) {
    const cells = [...groups.keys()].sort().map((k) => { const g = groups.get(k)!.filter((r) => r.probe === p.id); return `${k}=${g.filter((r) => r.pass).length}/${g.length}`; });
    console.log(`${p.id.padEnd(15)} ${cells.join("  ")}`);
  }
  const trapCounts: Record<string, number> = {};
  for (const r of rows) for (const t of r.traps) trapCounts[`${r.model}/${r.arm}:${t}`] = (trapCounts[`${r.model}/${r.arm}:${t}`] ?? 0) + 1;
  console.log("\ntraps", trapCounts);
}

if (cmd === "run") await run();
else if (cmd === "grade") await grade();
else if (cmd === "report") report();
else { console.error("usage: eval.ts run|grade|report"); process.exit(2); }
