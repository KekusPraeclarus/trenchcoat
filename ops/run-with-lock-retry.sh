#!/bin/sh
# Run a trenchcoat job with bounded workspace-lock contention retries.
# Exit 3 from `tc run` means the writer lock is held (INV-S15).
# Usage: run-with-lock-retry.sh <job-name> [extra tc args...]
set -eu

JOB="${1:-}"
if [ -z "$JOB" ]; then
  echo "usage: $0 <job-name> [args...]" >&2
  exit 2
fi
shift

TC="${TRENCHCOAT_BIN:-$HOME/.trenchcoat/bin/trenchcoat}"
MAX_ATTEMPTS=3
attempt=1

while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  set +e
  "$TC" run "$JOB" "$@"
  rc=$?
  set -e
  if [ "$rc" -ne 3 ]; then
    exit "$rc"
  fi
  if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
    echo "lock held after ${MAX_ATTEMPTS} attempts for $JOB" >&2
    exit 3
  fi
  r="$(od -An -N2 -tu2 /dev/urandom | tr -d ' ')"
  delay=$((30 + (r % 151)))
  echo "workspace lock held; retry $attempt/${MAX_ATTEMPTS} in ${delay}s" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done

exit 3
