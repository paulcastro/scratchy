// Shared headless Claude Code launcher and the observational docs-loaded detector.
//
// Isolation: `--setting-sources project` drops user/local settings (user hooks, plugins,
// model). The user's auth (`apiKeyHelper`, `env`) is carried over through a harness-owned
// `--settings` file that also installs the InstructionsLoaded logging hook, identically in
// every arm. Auto memory is off via CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 and
// `autoMemoryEnabled: false` (https://code.claude.com/docs/en/memory.md, "Auto memory").
//
// Detector: InstructionsLoaded fires for every CLAUDE.md load, at session start and for lazy
// nested loads, and for files a CLAUDE.md `@`-imports with load_reason "include"; it does NOT
// fire for an AGENTS.md read directly through the Project instructions setting
// (https://code.claude.com/docs/en/hooks.md, "InstructionsLoaded"). Every arm reaches its
// AGENTS.md through a CLAUDE.md import, so the hook sees all of them. The hook appends its
// stdin JSON to $AMD_LOADED_LOG; nothing is derived from assistant text or Read results.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, relative } from "path";

export const CALL_TIMEOUT_MS = Number(process.env.AMD_EVAL_CALL_TIMEOUT_MS ?? 300_000);
const HOOK_CMD = `cat >> "$AMD_LOADED_LOG"; echo >> "$AMD_LOADED_LOG"`;

export async function claudeVersion(): Promise<string> {
  const p = Bun.spawn(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()).trim();
  if ((await p.exited) !== 0 || !out) throw new Error("`claude --version` failed");
  return out;
}

/** Writes the harness settings file (auth from ~/.claude/settings.json + the logging hook). */
export function writeSettings(out: string): string {
  const userFile = join(homedir(), ".claude/settings.json");
  const user = existsSync(userFile) ? JSON.parse(readFileSync(userFile, "utf8")) : {};
  const settings: Record<string, unknown> = {
    autoMemoryEnabled: false,
    hooks: { InstructionsLoaded: [{ hooks: [{ type: "command", command: HOOK_CMD }] }] },
  };
  for (const k of ["apiKeyHelper", "env"]) if (user[k] !== undefined) settings[k] = user[k];
  const f = join(out, "claude-settings.json");
  mkdirSync(out, { recursive: true });
  writeFileSync(f, JSON.stringify(settings, null, 2));
  return f;
}

export type CallResult = {
  exit: number | null;
  timed_out: boolean;
  wall_s: number;
  cost_usd: number | null;
  result: any | null;
  transcript: string;
  loaded_log: string;
};

/** One headless claude call in `wt`; transcript + hook log land at `<stem>.jsonl` / `<stem>.loaded.jsonl`. */
export async function runClaude(o: {
  prompt: string; wt: string; stem: string; settings: string; model?: string;
  env?: Record<string, string>; ledger: string; ledgerExtra: Record<string, unknown>;
}): Promise<CallResult> {
  const transcript = `${o.stem}.jsonl`, loaded_log = `${o.stem}.loaded.jsonl`;
  mkdirSync(dirname(o.stem), { recursive: true });
  writeFileSync(loaded_log, "");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...o.env };
  delete env.CLAUDECODE;
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.AMD_LOADED_LOG = loaded_log;
  const t0 = performance.now();
  const p = Bun.spawn(
    ["claude", "-p", o.prompt, "--model", o.model ?? "sonnet", "--output-format", "stream-json", "--verbose",
      "--dangerously-skip-permissions", "--no-session-persistence", "--max-budget-usd", "1",
      "--setting-sources", "project", "--settings", o.settings],
    { cwd: o.wt, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  let timed_out = false;
  const timer = setTimeout(() => { timed_out = true; p.kill("SIGKILL"); }, CALL_TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const exit = await p.exited;
  clearTimeout(timer);
  const wall_s = (performance.now() - t0) / 1000;
  writeFileSync(transcript, stdout);
  if (stderr.trim()) writeFileSync(`${o.stem}.stderr.txt`, stderr);
  const result = parseEvents(stdout).findLast((e) => e.type === "result") ?? null;
  const cost_usd = typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null;
  appendFileSync(o.ledger, JSON.stringify({ ...o.ledgerExtra, cost_usd, exit, timed_out, wall_s, ts: new Date().toISOString() }) + "\n");
  return { exit, timed_out, wall_s, cost_usd, result, transcript, loaded_log };
}

export const parseEvents = (jsonl: string): any[] =>
  jsonl.split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

export type Load = { path: string; load_reason: string; memory_type: string; parent?: string };

/** InstructionsLoaded records from a hook log, paths made relative to `wt` (outside-wt paths kept absolute). */
export function loadsFromHookLog(logText: string, wt: string): Load[] {
  const rel = (p: string) => (p.startsWith(wt + "/") ? relative(wt, p) : p);
  return parseEvents(logText)
    .filter((e) => e.hook_event_name === "InstructionsLoaded" && typeof e.file_path === "string")
    .map((e) => ({
      path: rel(e.file_path), load_reason: e.load_reason, memory_type: e.memory_type,
      ...(e.parent_file_path ? { parent: rel(e.parent_file_path) } : {}),
    }));
}

/** The docs_loaded detector: sorted unique AGENTS.md paths the hook saw load. */
export const docsLoaded = (loads: Load[]): string[] =>
  [...new Set(loads.map((l) => l.path).filter((p) => /(^|\/)AGENTS\.md$/.test(p)))].sort();
