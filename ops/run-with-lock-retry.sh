#!/bin/sh
# Run a trenchcoat job with bounded workspace-lock / deploy-pause retries.
# Exit 3 from `tc run` means the writer lock is held (INV-S15) or deploy pause
# is active — keep retrying. Improvement jobs (`harness-improve`,
# `incident-remediate*`) skip the agent lock; exit 3 for them is deploy-pause
# only. While ~/.trenchcoat/deploy-pause.json exists, do not burn attempt budget
# (jobs resume as soon as upgrade clears the pause).
# Usage: run-with-lock-retry.sh <job-name> [extra tc args...]
set -eu

JOB="${1:-}"
if [ -z "$JOB" ]; then
  echo "usage: $0 <job-name> [args...]" >&2
  exit 2
fi
shift

TC="${TRENCHCOAT_BIN:-$HOME/.trenchcoat/bin/trenchcoat}"
PAUSE_FILE="${TRENCHCOAT_HOME:-$HOME/.trenchcoat}/deploy-pause.json"
MAX_ATTEMPTS=3
attempt=1

wait_for_deploy_pause() {
  if [ ! -f "$PAUSE_FILE" ]; then
    return 0
  fi
  echo "deploy pause active — waiting to run $JOB" >&2
  while [ -f "$PAUSE_FILE" ]; do
    sleep 5
  done
  echo "deploy pause cleared — running $JOB" >&2
}

while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  wait_for_deploy_pause
  set +e
  "$TC" run "$JOB" "$@"
  rc=$?
  set -e
  if [ "$rc" -ne 3 ]; then
    exit "$rc"
  fi
  # Pause may have been set mid-run attempt — wait then retry without burning
  if [ -f "$PAUSE_FILE" ]; then
    continue
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
