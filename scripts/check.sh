#!/usr/bin/env bash
# The gate. A spec ships only when this exits 0.
#
#   ./scripts/check.sh              typecheck + tests + probe
#   ./scripts/check.sh --no-probe   skip the opencode probe
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# bun's installer puts the PATH export in .zshrc, which non-interactive shells
# (including tool calls from an agent) do not source. Find it anyway.
find_bun() {
  if command -v bun >/dev/null 2>&1; then command -v bun; return; fi
  for candidate in "${BUN_INSTALL:-$HOME/.bun}/bin/bun" "$HOME/.bun/bin/bun" \
                   /opt/homebrew/bin/bun /usr/local/bin/bun; do
    [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
}
BUN="$(find_bun)"
[ -n "$BUN" ] && PATH="$(dirname "$BUN"):$PATH" && export PATH

FAIL=0
step() { printf '\n=== %s ===\n' "$1"; }

# Runtime detection: this repo targets bun, but falls back to node so the gate
# still runs where bun is not installed.
if [ -n "$BUN" ]; then
  RUNTIME="bun ($("$BUN" --version 2>/dev/null))"
  # Explicit file paths only. `bun test` and `bun test test/` walk the whole
  # tree (both node_modules trees included) and hang indefinitely here; an
  # explicit path list runs in milliseconds.
  TEST_CMD=("$BUN" test)
else
  RUNTIME=node
  TEST_CMD=(node --test)
fi

if [ -x ./node_modules/.bin/tsc ]; then
  TSC=(./node_modules/.bin/tsc)
elif [ -n "$BUN" ]; then
  TSC=("$BUN" x tsc)
else
  TSC=(npx --no-install tsc)
fi

echo "runtime: $RUNTIME  ·  tests: ${TEST_CMD[*]}  ·  typecheck: ${TSC[*]}"

step "typecheck"
if "${TSC[@]}" --noEmit; then
  echo "typecheck: clean"
else
  echo "typecheck: FAILED"
  FAIL=1
fi

step "tests"
TEST_FILES=()
if [ -d test ]; then
  for f in test/*.mjs; do [ -e "$f" ] && TEST_FILES+=("$f"); done
fi
if [ "${#TEST_FILES[@]}" -gt 0 ]; then
  if "${TEST_CMD[@]}" "${TEST_FILES[@]}"; then
    echo "tests: passed"
  else
    echo "tests: FAILED"
    FAIL=1
  fi
else
  echo "tests: none yet (test/*.mjs is defined by docs/specs/00-contract.md)"
fi

if [ "${1:-}" != "--no-probe" ]; then
  step "opencode probe"
  if ./scripts/oc-probe.sh; then
    echo "probe: clean"
  else
    echo "probe: FAILED"
    FAIL=1
  fi
fi

step "verdict"
if [ "$FAIL" -eq 0 ]; then
  echo "PASS"
else
  echo "FAIL"
fi
exit "$FAIL"
