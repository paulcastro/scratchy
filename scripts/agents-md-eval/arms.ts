// Materializes one documentation arm into an existing worktree of BASE.
//   A = BASE untouched.
//   B = every AGENTS.md from DOCS at its path, plus a CLAUDE.md `@AGENTS.md` shim per dir.
//   C = one root AGENTS.md (root doc + every child doc under a dir header), root CLAUDE.md shim.
import { $ } from "bun";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export type Arm = "A" | "B" | "C";
export const ARMS: readonly Arm[] = ["A", "B", "C"];
const REPO = join(import.meta.dir, "../..");
const SHIM = "@AGENTS.md\n";

export async function resolveCommit(ref: string): Promise<string> {
  const r = await $`git -C ${REPO} rev-parse --verify ${ref + "^{commit}"}`.quiet().nothrow();
  if (r.exitCode !== 0) throw new Error(`cannot resolve ref '${ref}' to a commit`);
  return r.stdout.toString().trim();
}

export async function docList(docsSha: string): Promise<string[]> {
  const all = (await $`git -C ${REPO} ls-tree -r --name-only ${docsSha}`.quiet().text()).split("\n");
  return all.filter((p) => /(^|\/)AGENTS\.md$/.test(p));
}

const show = (sha: string, path: string) => $`git -C ${REPO} show ${`${sha}:${path}`}`.quiet().text();

export async function materialize(arm: Arm, wt: string, docsRef: string): Promise<{ files: string[] }> {
  if (!ARMS.includes(arm)) throw new Error(`unknown arm '${arm}' (expected A, B or C)`);
  const sha = await resolveCommit(docsRef);
  if (!existsSync(join(wt, ".git"))) throw new Error(`${wt} is not a git worktree`);
  if (arm === "A") return { files: [] };

  // Read every doc before writing anything, so a failed read leaves the worktree untouched.
  const paths = await docList(sha);
  const docs = new Map(await Promise.all(paths.map(async (p) => [p, await show(sha, p)] as const)));
  if (!docs.has("AGENTS.md")) throw new Error(`${docsRef} has no root AGENTS.md`);

  const shim = (dir: string) => {
    const f = join(wt, dir, "CLAUDE.md");
    if (existsSync(f)) appendFileSync(f, "\n" + SHIM);
    else writeFileSync(f, SHIM);
    return join(dir, "CLAUDE.md");
  };

  const files: string[] = [];
  if (arm === "B") {
    for (const [p, body] of docs) {
      mkdirSync(join(wt, dirname(p)), { recursive: true });
      writeFileSync(join(wt, p), body);
      files.push(p);
    }
    if (process.env.AMD_EVAL_FORCE_NO_SHIM !== "1") for (const p of paths) files.push(shim(dirname(p)));
  } else {
    let flat = docs.get("AGENTS.md")!;
    for (const p of paths) {
      if (p === "AGENTS.md") continue;
      const d = dirname(p);
      flat += `\n\n# ${d}/ (applies to files under ${d}/)\n\n` + docs.get(p)!;
    }
    writeFileSync(join(wt, "AGENTS.md"), flat);
    files.push("AGENTS.md", shim("."));
  }
  return { files: files.map((f) => f.replace(/^\.\//, "")) };
}
