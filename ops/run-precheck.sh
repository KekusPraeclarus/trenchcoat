#!/bin/sh
# Best-effort host precondition gate before acquiring the workspace lock.
# Authoritative skip still happens inside `tc run` under lock.
# Usage: run-precheck.sh <job-name> [extra tc run args...]
set -eu

JOB="${1:-}"
if [ -z "$JOB" ]; then
  echo "usage: $0 <job-name> [args...]" >&2
  exit 2
fi
# Fail closed: only allow known job name characters
case "$JOB" in
  *[!a-z0-9-]*)
    echo "invalid job name: $JOB" >&2
    exit 2
    ;;
esac
shift

TC="${TRENCHCOAT_BIN:-$HOME/.trenchcoat/bin/trenchcoat}"
BIN_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"

set +e
"$TC" precheck "$JOB"
rc=$?
set -e
# 10 = skip (noop); 0 = proceed; anything else = hard failure
if [ "$rc" -eq 10 ]; then
  exit 0
fi
if [ "$rc" -ne 0 ]; then
  exit "$rc"
fi

exec "$BIN_DIR/run-with-lock-retry.sh" "$JOB" "$@"
