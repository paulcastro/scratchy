// Stand-in for `claude -p` used when AMD_EVAL_FAKE_CLAUDE=1 (selftest only). Writes a canned
// stream-json transcript costing $0.40 and one InstructionsLoaded record per doc file in cwd.
//   AMD_EVAL_FAKE_MS      how long the call takes (default 300)
//   AMD_EVAL_FAKE_HANG=1  never finish, with a grandchild holding stdout (timeout test)
//   AMD_EVAL_FAKE_BUDGET=1 end with error_max_budget_usd and exit 1
//   AMD_EVAL_FAKE_LOG     append {pid, ev: start|end, t} lines (concurrency / launch counting)
import { appendFileSync, existsSync, realpathSync } from "fs";
import { join } from "path";

const env = process.env;
const log = (ev: string) => env.AMD_EVAL_FAKE_LOG && appendFileSync(env.AMD_EVAL_FAKE_LOG, JSON.stringify({ pid: process.pid, ev, t: Date.now() }) + "\n");
log("start");
const cwd = realpathSync(process.cwd());
for (const f of ["CLAUDE.md", "AGENTS.md"]) if (existsSync(join(cwd, f)) && env.AMD_LOADED_LOG)
  appendFileSync(env.AMD_LOADED_LOG, JSON.stringify({ hook_event_name: "InstructionsLoaded", file_path: join(cwd, f), load_reason: "session_start", memory_type: "Project" }) + "\n");

if (env.AMD_EVAL_FAKE_HANG === "1") {
  Bun.spawn(["sleep", "600"], { stdout: "inherit" });
  await Bun.sleep(600_000);
}
await Bun.sleep(Number(env.AMD_EVAL_FAKE_MS ?? 300));

const tool = (name: string, input: unknown) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: name, name, input }] } });
const budget = env.AMD_EVAL_FAKE_BUDGET === "1";
const events = [
  { type: "system", subtype: "init", model: "fake/claude-sonnet", cwd },
  tool("Grep", { pattern: "members" }),
  tool("Bash", { command: "ls crates" }),
  tool("Read", { file_path: join(cwd, "crates/targets/metal/src/lib.rs") }),
  { type: "assistant", message: { content: [{ type: "text", text: "ANSWER: 39" }] } },
  {
    type: "result", subtype: budget ? "error_max_budget_usd" : "success", is_error: budget, num_turns: 4,
    total_cost_usd: 0.4, result: budget ? "" : "ANSWER: 39",
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
  },
];
for (const e of events) console.log(JSON.stringify(e));
log("end");
process.exit(budget ? 1 : 0);
