// Freeze of what a matrix result means: probes, graders, group labels and the verdict rules.
// `eval.ts freeze` writes frozen.json; `run --ns matrix` refuses unless frozen.json matches the current files
// and both are committed (clean in git), so nothing can be tuned after matrix results are seen.
// AMD_EVAL_FROZEN overrides the frozen.json path (selftest only).
import { $ } from "bun";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { VERDICT_RULES } from "./report";

const HERE = import.meta.dir;
export const FROZEN = process.env.AMD_EVAL_FROZEN ?? join(HERE, "frozen.json");
const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const file = (f: string) => readFileSync(join(HERE, f), "utf8");

export function frozenHashes(): Record<string, string> {
  const probes = JSON.parse(file("probes.json")).probes;
  return {
    "probes.json": sha256(file("probes.json")),
    "grade.ts": sha256(file("grade.ts")),
    group_labels: sha256(JSON.stringify(probes.map((p: any) => [p.id, p.group]))),
    VERDICT_RULES: sha256(VERDICT_RULES),
  };
}

export function writeFrozen(): Record<string, string> {
  const h = frozenHashes();
  writeFileSync(FROZEN, JSON.stringify(h, null, 2) + "\n");
  return h;
}

/** null when frozen.json matches the current files and the frozen files are committed; else the refusal. */
export async function frozenGate(): Promise<string | null> {
  if (!existsSync(FROZEN)) return `run --ns matrix refused: ${FROZEN} missing (run \`eval.ts freeze\` and commit)`;
  const want = JSON.parse(readFileSync(FROZEN, "utf8")), got = frozenHashes();
  const diff = Object.keys(got).filter((k) => want[k] !== got[k]);
  if (diff.length) return `run --ns matrix refused: frozen hash mismatch for ${diff.join(", ")} (${FROZEN})`;
  const paths = [FROZEN, ...["probes.json", "grade.ts", "report.ts"].map((f) => join(HERE, f))];
  const dirty = (await $`git -C ${HERE} status --porcelain --untracked-files=all -- ${paths}`.quiet().nothrow().text()).trim();
  if (dirty) return `run --ns matrix refused: frozen files are not committed:\n${dirty}`;
  return null;
}
