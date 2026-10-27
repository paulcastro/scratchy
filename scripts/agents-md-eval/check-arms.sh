#!/usr/bin/env bash
# Asserts the A/B/C arm materializer rules on fresh /tmp/amd-m-{A,B,C} worktrees of BASE.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
EVAL="$REPO/scripts/agents-md-eval/eval.ts"
BASE=${AMD_EVAL_BASE:-acc4046b}
DOCS=$(git -C "$REPO" rev-parse --verify "${AMD_EVAL_DOCS_REF:-docs/agents-md}^{commit}")
fails=0
# The plan expects 41 docs; the count asserted is the one actually in DOCS, so a drift is reported, not hidden.
N=$(git -C "$REPO" ls-tree -r --name-only "$DOCS" | grep -cE '(^|/)AGENTS\.md$')
echo "DOCS $DOCS holds $N AGENTS.md file(s)"
[[ $N -eq 41 ]] || echo "NOTE: plan expects 41 AGENTS.md files; $DOCS holds $N"
ok() { echo "PASS: $*"; }
bad() { echo "FAIL: $*"; fails=$((fails + 1)); }
check() { local what=$1; shift; if "$@"; then ok "$what"; else bad "$what"; fi; }

cleanup() {
  for a in A B C; do git -C "$REPO" worktree remove --force "/tmp/amd-m-$a" 2>/dev/null || true; done
  git -C "$REPO" worktree prune
}
trap cleanup EXIT
cleanup

for a in A B C; do
  git -C "$REPO" worktree add --detach "/tmp/amd-m-$a" "$BASE" >/dev/null 2>&1
  bun "$EVAL" materialize --arm "$a" --dir "/tmp/amd-m-$a"
done

# Every added diff line except the blank separator must be exactly `@AGENTS.md`.
shim_only() {
  local wt=$1 stat added
  stat=$(git -C "$wt" diff --numstat)
  echo "  diff --numstat: ${stat//$'\t'/ }"
  added=$(git -C "$wt" diff -U0 | grep '^+[^+]' || true)
  [[ $(awk '{print $3}' <<<"$stat") == CLAUDE.md && $(awk '{print $2}' <<<"$stat") == 0 && "$added" == "+@AGENTS.md" ]]
}

echo "== arm A"
check "A: git status --porcelain is empty" test -z "$(git -C /tmp/amd-m-A status --porcelain)"

echo "== arm B"
B=/tmp/amd-m-B
nb=$(find "$B" -name AGENTS.md -not -path '*/.git/*' | wc -l | tr -d ' ')
check "B: $N AGENTS.md files (got $nb)" test "$nb" -eq "$N"
missing=0
while read -r f; do
  d=$(dirname "$f")
  grep -qx '@AGENTS.md' "$d/CLAUDE.md" 2>/dev/null || { echo "  no @AGENTS.md shim in $d/CLAUDE.md"; missing=$((missing + 1)); }
done < <(find "$B" -name AGENTS.md -not -path '*/.git/*')
check "B: every AGENTS.md dir has a CLAUDE.md with a line @AGENTS.md" test "$missing" -eq 0
check "B: tracked diff touches only CLAUDE.md, adding only the @AGENTS.md line" shim_only "$B"

echo "== arm C"
C=/tmp/amd-m-C
nc=$(find "$C" -name AGENTS.md -not -path '*/.git/*' | wc -l | tr -d ' ')
check "C: exactly 1 AGENTS.md (got $nc)" test "$nc" -eq 1
check "C: the one AGENTS.md is at the root" test -f "$C/AGENTS.md"
src=0
while read -r p; do src=$((src + $(git -C "$REPO" cat-file -s "$DOCS:$p"))); done \
  < <(git -C "$REPO" ls-tree -r --name-only "$DOCS" | grep -E '(^|/)AGENTS\.md$')
size=$(wc -c <"$C/AGENTS.md" | tr -d ' ')
check "C: size $size >= summed source size $src" test "$size" -ge "$src"
nh=$(grep -c '^# .*/ (applies to files under' "$C/AGENTS.md" || true)
check "C: $((N - 1)) dir headers (got $nh)" test "$nh" -eq $((N - 1))
check "C: root CLAUDE.md ends with @AGENTS.md" test "$(tail -n 1 "$C/CLAUDE.md")" = "@AGENTS.md"
check "C: tracked diff touches only CLAUDE.md, adding only the @AGENTS.md line" shim_only "$C"

echo "== cleanup"
trap - EXIT
cleanup
left=$(git -C "$REPO" worktree list | grep -c '/tmp/amd-m-' || true)
check "no /tmp/amd-m-* worktrees remain (got $left)" test "$left" -eq 0

echo "== $fails failure(s)"
exit $((fails > 0))
