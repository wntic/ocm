#!/usr/bin/env bash
# Ask the real opencode binary what it resolves from a scratch config directory
# containing this repository's loader files. This is the executable form of
# docs/specs/00-contract.md: when opencode changes, this is what notices.
#
#   ./scripts/oc-probe.sh            probe and report
#   ./scripts/oc-probe.sh --keep     leave the scratch directory in place
#
# exit 0 healthy · 1 plugin load errors · 2 probe cannot trust itself
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

if ! command -v opencode >/dev/null 2>&1; then
  echo "probe: skipped — opencode is not on PATH"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ocm-probe.XXXXXX")"
cleanup() { [ "$KEEP" = 1 ] || rm -rf "$WORK"; }
trap cleanup EXIT

# Count "failed to load plugin" lines opencode emits for a given config dir.
# Both streams are captured: debug output goes to stdout, logs to stderr, and
# which carries what has changed between versions.
plugin_errors() {
  local dir="$1" out="$2"
  ( cd "$ROOT" && OPENCODE_CONFIG_DIR="$dir" \
      opencode debug skill --print-logs --log-level ERROR ) >"$out" 2>&1
  grep -cE 'level=ERROR.*failed to load plugin' "$out" 2>/dev/null | head -1
}

# --- 1. canary: prove this probe can still see a broken plugin -------------
# A module shape opencode must reject. If this is NOT detected, the probe's
# "no errors" answer means nothing and we must say so rather than pass.
CANARY="$WORK/canary"
mkdir -p "$CANARY/plugins"
cat > "$CANARY/plugins/canary.js" <<'JS'
export default { id: "probe-canary", setup: async () => ({}) }
JS
CANARY_HITS=$(plugin_errors "$CANARY" "$WORK/canary.log")
CANARY_HITS=${CANARY_HITS:-0}

# --- 2. the real probe -----------------------------------------------------
PROBE="$WORK/probe"
mkdir -p "$PROBE/plugins" "$PROBE/ocm"

# Only the loader itself may live in plugins/: opencode globs
# {plugin,plugins}/*.{ts,js} there and loads every match as a server plugin.
shopt -s nullglob
for f in "$ROOT"/loader/*.js; do
  case "$(basename "$f")" in
    ocm-loader.js|loader.js) cp "$f" "$PROBE/plugins/" ;;
    *)                       cp "$f" "$PROBE/ocm/" ;;
  esac
done
for f in "$ROOT"/loader/*.d.ts; do cp "$f" "$PROBE/ocm/"; done
shopt -u nullglob

# Silence node's CommonJS reparse warning during the import check.
printf '{ "type": "module" }\n' > "$PROBE/package.json"

UI=""
for candidate in ui.js ocm-ui.js; do
  [ -f "$PROBE/ocm/$candidate" ] && UI="./ocm/$candidate"
done
[ -n "$UI" ] && printf '{\n  "plugin": ["%s"]\n}\n' "$UI" > "$PROBE/tui.json"

echo "probe: opencode $(opencode --version 2>/dev/null)"
echo "probe: plugins/ $(ls "$PROBE/plugins" 2>/dev/null | tr '\n' ' ')"
echo "probe: ocm/     $(ls "$PROBE/ocm" 2>/dev/null | tr '\n' ' ')"
echo

( cd "$ROOT" && OPENCODE_CONFIG_DIR="$PROBE" opencode debug config ) \
  >"$WORK/config.json" 2>/dev/null

python3 - "$WORK/config.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as exc:
    print(f"resolved config: UNREADABLE ({exc})"); raise SystemExit(0)
def names(key): return sorted((d.get(key) or {}).keys())
print("commands:", ", ".join(names("command")) or "(none)")
print("agents:  ", ", ".join(names("agent")) or "(none)")
for spec in (d.get("plugin") or []):
    print("plugin:  ", spec if isinstance(spec, str) else spec[0])
PY

( cd "$ROOT" && OPENCODE_CONFIG_DIR="$PROBE" opencode debug skill ) 2>/dev/null \
  | python3 -c 'import json,sys; print("skills:  ", ", ".join(sorted(s["name"] for s in json.load(sys.stdin))))' \
  2>/dev/null || echo "skills:   (unreadable)"

# opencode reports load-stage failures but swallows import-stage ones, so a
# module whose own imports are broken looks clean in the log. Check directly.
IMPORT_RUNTIME="${BUN:-$(command -v node)}"
IMPORT_FAIL=0
for f in "$PROBE"/plugins/*.js; do
  [ -e "$f" ] || continue
  if ! err=$($IMPORT_RUNTIME -e "import('file://$f').catch(e => { console.error(e.message); process.exit(1) })" 2>&1); then
    echo "IMPORT FAILURE: $(basename "$f")"
    echo "$err" | grep -v '^(node:' | grep -v '^Reparsing\|^To eliminate' \
      | grep -v '^\s*$' | head -3 | sed 's/^/     /'
    IMPORT_FAIL=1
  fi
done
[ "$IMPORT_FAIL" -eq 1 ] && echo

HITS=$(plugin_errors "$PROBE" "$WORK/probe.log")
HITS=${HITS:-0}
echo

if [ "$CANARY_HITS" -eq 0 ]; then
  echo "PROBE UNRELIABLE: the canary broken plugin was not reported by this"
  echo "  opencode build, so a clean result here proves nothing. Inspect"
  echo "  $WORK/canary.log and update scripts/oc-probe.sh before trusting it."
  KEEP=1
  exit 2
fi

if [ "$HITS" -gt 0 ]; then
  echo "PLUGIN LOAD ERRORS: $HITS"
  grep -E 'level=ERROR.*failed to load plugin' "$WORK/probe.log" \
    | sed -E 's/^.*path=([^ ]+).*error="([^"]*)".*$/  \1\n     \2/'
  exit 1
fi

if [ "$IMPORT_FAIL" -eq 1 ]; then
  echo "plugin load errors: none reported, but a plugin file failed to import"
  echo "  (opencode swallows import-stage failures — fix the import above)"
  exit 1
fi

echo "plugin load errors: none (canary verified detection works)"
