#!/bin/sh
# Gate a job behind a jittered inter-run delay.
# launchd polls often; this script no-ops until the next due timestamp.
# list-scan: uniform [30m, 1h45m] after success. farcaster-scan: [3h15m, 4h45m].
# Failure backoff: 1h. Lock contention uses run-with-lock-retry (30–180s).
# Usage: run-job-jittered.sh <job-name>
set -eu

JOB="${1:-}"
case "$JOB" in
  list-scan)
    MIN_SEC=1800
    MAX_SEC=6300
    ;;
  farcaster-scan)
    MIN_SEC=11700
    MAX_SEC=17100
    ;;
  *)
    echo "usage: $0 list-scan|farcaster-scan" >&2
    exit 2
    ;;
esac
FAIL_SEC=3600
POLL_STATE_DIR="${TRENCHCOAT_HOME:-$HOME/.trenchcoat}/var"
NEXT_FILE="$POLL_STATE_DIR/${JOB}.next"
BIN_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
TC="${TRENCHCOAT_BIN:-$HOME/.trenchcoat/bin/trenchcoat}"
RETRY_WRAPPER="${BIN_DIR}/run-with-lock-retry.sh"
if [ ! -x "$RETRY_WRAPPER" ]; then
  RETRY_WRAPPER="${TRENCHCOAT_HOME:-$HOME/.trenchcoat}/bin/run-with-lock-retry"
fi

mkdir -p "$POLL_STATE_DIR"
now="$(date +%s)"

if [ -f "$NEXT_FILE" ]; then
  next="$(cat "$NEXT_FILE" 2>/dev/null || true)"
  case "$next" in
    ""|*[!0-9]*) ;;
    *)
      if [ "$now" -lt "$next" ]; then
        exit 0
      fi
      ;;
  esac
fi

set +e
if [ -x "$RETRY_WRAPPER" ]; then
  TRENCHCOAT_BIN="$TC" "$RETRY_WRAPPER" "$JOB"
  rc=$?
else
  "$TC" run "$JOB"
  rc=$?
fi
set -e

if [ "$rc" -eq 0 ]; then
  span=$((MAX_SEC - MIN_SEC + 1))
  r="$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')"
  delay=$((MIN_SEC + (r % span)))
  echo "$(($(date +%s) + delay))" >"$NEXT_FILE"
elif [ "$rc" -eq 3 ]; then
  # lock still held after retries — short backoff, do not burn the social cadence
  r="$(od -An -N2 -tu2 /dev/urandom | tr -d ' ')"
  delay=$((180 + (r % 421)))
  echo "$(($(date +%s) + delay))" >"$NEXT_FILE"
else
  echo "$(($(date +%s) + FAIL_SEC))" >"$NEXT_FILE"
fi

exit "$rc"
