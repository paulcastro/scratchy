// `eval.ts selftest` cases for grade.ts: every probe's good fixture must pass and its bad fixture fail; edit
// probes name ref/ patches in their fixtures (`patch: <file>` lines, `none` = pristine BASE) and are graded
// through a real run-like worktree carrying an arm-B shim edit. Plus traps, the todo-2 detector, malformed
// input, a 0-tests cargo run and a shim-only diff. AMD_EVAL_FIXTURES overrides the fixtures dir.
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { docsLoaded, loadsFromHookLog } from "./claude";
import { type EditEnv, PROBES, gradeAnswer, gradeEdit, gradeRun, trapHits } from "./grade";

const HERE = import.meta.dir;
const REPO = join(HERE, "../..");
const FIXTURES = process.env.AMD_EVAL_FIXTURES ?? join(HERE, "fixtures");
const DETECTOR = join(HERE, "fixtures/detector");

const patches = (text: string) => [...text.matchAll(/^patch:\s*(\S+)\s*$/gm)].map((m) => m[1]);

async function runWorktree(env: EditEnv, patch: string, fn: (wt: string) => Promise<boolean>): Promise<boolean> {
  const wt = join(env.wtRoot, `selftest-run-${process.pid}`);
  await $`git -C ${REPO} worktree remove --force ${wt}`.quiet().nothrow();
  await $`git -C ${REPO} worktree add --detach ${wt} ${env.base}`.quiet();
  try {
    if (patch !== "none") await $`git apply ${join(HERE, "ref", patch)}`.cwd(wt).quiet();
    // The arm-B shim and doc edits a materialized run carries; they must never reach the graded diff.
    writeFileSync(join(wt, "crates/serving/scheduler/CLAUDE.md"), "@AGENTS.md\n");
    writeFileSync(join(wt, "crates/serving/scheduler/AGENTS.md"), "# scheduler\n2041\n");
    writeFileSync(join(wt, "CLAUDE.md"), readFileSync(join(wt, "CLAUDE.md"), "utf8") + "\n@AGENTS.md\n");
    return await fn(wt);
  } finally {
    await $`git -C ${REPO} worktree remove --force ${wt}`.quiet().nothrow();
    rmSync(wt, { recursive: true, force: true });
  }
}

const editPasses = async (p: any, env: EditEnv, patch: string) => {
  let note = "";
  const pass = await runWorktree(env, patch, async (wt) => { const v = await gradeEdit(p, wt, env); note = v.note; return v.pass; });
  console.log(`       ${p.id} ${patch}: ${pass ? "pass" : "fail"} (${note})`);
  return pass;
};

const tx = (...uses: [string, any][]) => uses.map(([name, input]) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } })).join("\n") + "\n";

export async function gradeSelftest(out: string, base: string): Promise<number> {
  const env: EditEnv = {
    base: (await $`git -C ${REPO} rev-parse --verify ${base + "^{commit}"}`.quiet().text()).trim(),
    targetDir: join(out, "cargo-target", "grade"), wtRoot: `/tmp/amd-grade-selftest-${process.pid}-wt`,
  };
  mkdirSync(env.wtRoot, { recursive: true });
  const failures: string[] = [];
  let good = 0, bad = 0, traps = true, detector = true;
  const extra = (name: string, ok: boolean) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failures.push(name); return ok; };
  try {
    for (const p of PROBES) {
      const read = (k: string) => { const f = join(FIXTURES, `${p.id}.${k}.txt`); return existsSync(f) ? readFileSync(f, "utf8") : ""; };
      const [g, b] = [read("good"), read("bad")];
      let gp: boolean, bf: boolean;
      if (p.kind === "edit") {
        const gl = patches(g), bl = patches(b);
        gp = gl.length > 0;
        for (const x of gl) gp = (await editPasses(p, env, x)) && gp;
        bf = bl.length > 0;
        for (const x of bl) bf = !(await editPasses(p, env, x)) && bf;
      } else {
        const gv = gradeAnswer(p, g), bv = gradeAnswer(p, b);
        gp = gv.pass; bf = !bv.pass;
        if (!gp) console.log(`       ${p.id} good: ${gv.note}`);
      }
      good += +gp; bad += +bf;
      console.log(`${gp && bf ? "ok  " : "FAIL"} grade ${p.id}: good ${gp ? "pass" : "FAIL"}, bad ${bf ? "fail" : "PASS"}`);
      if (!(gp && bf)) failures.push(p.id);
    }

    const clean = tx(["Bash", { command: "cargo build -p scratchy-cli --features metal,model/smollm2-135m" }],
      ["Bash", { command: "cargo test -p scratchy-serving-scheduler --features model/llama-3.2-1b" }],
      ["Edit", { file_path: "crates/targets/metal/src/lib.rs", old_string: "a", new_string: "let cb = queue.commandBufferWithDescriptor(d);" }]);
    const dirty = tx(["Edit", { file_path: "crates/targets/metal/src/x.rs", old_string: "a", new_string: "let cb = queue.commandBuffer();" }],
      ["Bash", { command: "cargo build -p scratchy-cli --features metal,model/all" }]);
    const dh = trapHits(dirty), ch = trapHits(clean);
    traps = extra(`traps: tripping transcript -> ${JSON.stringify(dh)}, clean -> ${JSON.stringify(ch)}`,
      JSON.stringify([...new Set(dh)].sort()) === '["command_buffer","unscoped_build"]' && ch.length === 0);

    const det = (arm: string) => docsLoaded(loadsFromHookLog(readFileSync(join(DETECTOR, `${arm}-P1.loaded.jsonl`), "utf8"), `/private/tmp/scratchy-amd-eval-wt/preflight-${arm}`));
    const [dA, dB] = [det("A"), det("B")];
    detector = extra(`detector: A-P1 -> ${JSON.stringify(dA)}, B-P1 -> ${JSON.stringify(dB)}`, dA.length === 0 && dB.includes("crates/targets/metal/AGENTS.md"));

    const junk = ["", "garbage \u0000\u0001 ]]{{", "ANSWER without a colon", "answer: lowercase", "ANSWER:", "ANSWER: =,=,=", undefined as any, null as any];
    let crashed = "";
    const malformedOk = PROBES.filter((p) => p.kind === "answer").every((p) => junk.every((j) => {
      try { return !gradeAnswer(p, j).pass; } catch (e: any) { crashed = `${p.id}: ${e.message}`; return false; }
    }));
    extra(`malformed answers fail without crashing${crashed ? ` (${crashed})` : ""}`, malformedOk);
    const empty = await gradeRun({ probe: "metal-skip", final: PROBES[0].key, wt: "/nonexistent" }, "", env);
    extra(`empty transcript -> ${JSON.stringify(empty.note)}`, !empty.pass && empty.note === "empty transcript");

    const sched = PROBES.find((p) => p.id === "write-sched-test");
    extra("cargo_test: test filtered to 0 tests (misnamed) fails", !(await editPasses(sched, env, "write-sched-test.misnamed.patch")));
    extra("cargo_test: missing test name fails", !(await editPasses({ ...sched, check: { ...sched.check, test: "test_no_such_test_amd" } }, env, "write-sched-test.patch")));
    extra("shim-only dirty worktree is no graded diff", !(await editPasses(sched, env, "none")));
  } finally {
    await $`git -C ${REPO} worktree prune`.quiet().nothrow();
    rmSync(env.wtRoot, { recursive: true, force: true });
  }
  const n = PROBES.length;
  if (failures.length) console.log(`grade selftest FAILED: ${failures.join(", ")}`);
  console.log(`selftest: ${good}/${n} good pass, ${bad}/${n} bad fail, traps ${traps ? "ok" : "FAIL"}, detector ${detector ? "ok" : "FAIL"}`);
  return failures.length ? 1 : 0;
}
