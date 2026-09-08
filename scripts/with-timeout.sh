#!/usr/bin/env bash
# macOS has no coreutils `timeout`. Use perl's alarm to bound any command, so a
# slow step can never wedge a `!` block in a command template.
#   ./scripts/with-timeout.sh 20 some-command --flag
set -uo pipefail
SECS="${1:?usage: with-timeout.sh <seconds> <command...>}"; shift
perl -e 'alarm shift; exec @ARGV or exit 127' "$SECS" "$@"
status=$?
[ "$status" -eq 142 ] && echo "(timed out after ${SECS}s)" >&2
exit "$status"
