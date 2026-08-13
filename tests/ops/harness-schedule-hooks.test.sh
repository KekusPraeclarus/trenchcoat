#!/usr/bin/env bash
# Assert audit→harness scheduling hooks in install-systemd / install-launchd.
# Uses dry-run + TRENCHCOAT_INSTALL_MATERIALIZE to write unit bodies without
# deploying runtime or loading services.
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/tc-harness-hooks.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

bash -n "$ROOT/ops/install-systemd.sh"
bash -n "$ROOT/ops/install-launchd.sh"
bash -n "$0"

materialize_systemd() {
  local home="$1"
  shift
  mkdir -p "$home/.trenchcoat" "$home/.config/systemd/user" "$home/bin"
  # Minimal stubs so dry-run install can progress past host prep when materializing
  : >"$home/.trenchcoat/env"
  printf '{}\n' >"$home/.trenchcoat/config.json"
  HOME="$home" TRENCHCOAT_INSTALL_MATERIALIZE=1 \
    "$ROOT/ops/install-systemd.sh" --dry-run --jobs-only --no-load --allow-dirty --skip-agent-wait "$@"
}

materialize_launchd() {
  local home="$1"
  shift
  mkdir -p "$home/.trenchcoat" "$home/Library/LaunchAgents" "$home/bin"
  : >"$home/.trenchcoat/env"
  printf '{}\n' >"$home/.trenchcoat/config.json"
  HOME="$home" TRENCHCOAT_INSTALL_MATERIALIZE=1 \
    "$ROOT/ops/install-launchd.sh" --dry-run --jobs-only --no-load --allow-dirty --skip-agent-wait "$@"
}

echo "== systemd with harness =="
SYS_WITH="$TMP/sys-with"
materialize_systemd "$SYS_WITH"
AUDIT_SVC="$SYS_WITH/.config/systemd/user/trenchcoat-job-audit.service"
HARNESS_SVC="$SYS_WITH/.config/systemd/user/trenchcoat-job-harness-improve.service"
HARNESS_TIMER="$SYS_WITH/.config/systemd/user/trenchcoat-job-harness-improve.timer"
test -f "$AUDIT_SVC"
test -f "$HARNESS_SVC"
test -f "$HARNESS_TIMER"
grep -q 'ExecStart=.*run-precheck audit' "$AUDIT_SVC"
grep -q 'ExecStartPost=.*systemctl --user --no-block start trenchcoat-job-harness-improve.service' "$AUDIT_SVC"
# Audit command itself remains run-precheck audit (unchanged computation path)
grep -E 'ExecStart=/bin/sh -c .*run-precheck audit' "$AUDIT_SVC" >/dev/null
# Harness remains an independent oneshot service
grep -q 'ExecStart=.*run-with-lock-retry harness-improve\|ExecStart=.*run-precheck harness-improve' "$HARNESS_SVC" \
  || grep -q 'harness-improve' "$HARNESS_SVC"
# Post is non-blocking
grep -q -- '--no-block' "$AUDIT_SVC"

echo "== systemd without harness =="
SYS_WITHOUT="$TMP/sys-without"
materialize_systemd "$SYS_WITHOUT" --without-harness
AUDIT_SVC2="$SYS_WITHOUT/.config/systemd/user/trenchcoat-job-audit.service"
test -f "$AUDIT_SVC2"
! grep -q 'ExecStartPost=.*harness-improve' "$AUDIT_SVC2"
! test -f "$SYS_WITHOUT/.config/systemd/user/trenchcoat-job-harness-improve.service"
grep -q 'ExecStart=.*run-precheck audit' "$AUDIT_SVC2"

echo "== launchd with harness =="
LD_WITH="$TMP/ld-with"
materialize_launchd "$LD_WITH"
AUDIT_PLIST="$LD_WITH/Library/LaunchAgents/com.trenchcoat.job.audit.plist"
HARNESS_PLIST="$LD_WITH/Library/LaunchAgents/com.trenchcoat.job.harness-improve.plist"
test -f "$AUDIT_PLIST"
test -f "$HARNESS_PLIST"
# Success-only kickstart of independent harness job
grep -q 'run-precheck audit' "$AUDIT_PLIST"
grep -q 'st=\$?' "$AUDIT_PLIST"
grep -q 'launchctl kickstart' "$AUDIT_PLIST"
grep -q 'com.trenchcoat.job.harness-improve' "$AUDIT_PLIST"
# Backgrounded (non-blocking)
grep -q 'kickstart .* &' "$AUDIT_PLIST" || grep -q '>/dev/null 2>&1 &' "$AUDIT_PLIST"
# Harness remains independent
grep -q 'harness-improve' "$HARNESS_PLIST"

echo "== launchd without harness =="
LD_WITHOUT="$TMP/ld-without"
materialize_launchd "$LD_WITHOUT" --without-harness
AUDIT_PLIST2="$LD_WITHOUT/Library/LaunchAgents/com.trenchcoat.job.audit.plist"
test -f "$AUDIT_PLIST2"
! grep -q 'launchctl kickstart' "$AUDIT_PLIST2"
! test -f "$LD_WITHOUT/Library/LaunchAgents/com.trenchcoat.job.harness-improve.plist"
grep -q 'run-precheck audit' "$AUDIT_PLIST2"

echo "== farcaster omitted by default =="
# Default installs must leave no Farcaster unit, timer, plist, or wrapper.
! test -f "$SYS_WITH/.config/systemd/user/trenchcoat-job-farcaster-scan.service"
! test -f "$SYS_WITH/.config/systemd/user/trenchcoat-job-farcaster-scan.timer"
! test -f "$SYS_WITH/.config/systemd/user/trenchcoat-job-fc-source-review.service"
! test -f "$SYS_WITH/.config/systemd/user/trenchcoat-job-fc-source-review.timer"
! test -f "$LD_WITH/Library/LaunchAgents/com.trenchcoat.job.farcaster-scan.plist"
! test -f "$LD_WITH/Library/LaunchAgents/com.trenchcoat.job.fc-source-review.plist"

echo "== farcaster removed from an earlier install =="
SYS_STALE="$TMP/sys-stale"
mkdir -p "$SYS_STALE/.config/systemd/user"
: >"$SYS_STALE/.config/systemd/user/trenchcoat-job-farcaster-scan.timer"
: >"$SYS_STALE/.config/systemd/user/trenchcoat-job-fc-source-review.service"
materialize_systemd "$SYS_STALE"
! test -f "$SYS_STALE/.config/systemd/user/trenchcoat-job-farcaster-scan.timer"
! test -f "$SYS_STALE/.config/systemd/user/trenchcoat-job-fc-source-review.service"

LD_STALE="$TMP/ld-stale"
mkdir -p "$LD_STALE/Library/LaunchAgents"
: >"$LD_STALE/Library/LaunchAgents/com.trenchcoat.job.farcaster-scan.plist"
: >"$LD_STALE/Library/LaunchAgents/com.trenchcoat.job.fc-source-review.plist"
materialize_launchd "$LD_STALE"
! test -f "$LD_STALE/Library/LaunchAgents/com.trenchcoat.job.farcaster-scan.plist"
! test -f "$LD_STALE/Library/LaunchAgents/com.trenchcoat.job.fc-source-review.plist"

echo "== farcaster installed only on explicit opt-in =="
SYS_FC="$TMP/sys-fc"
materialize_systemd "$SYS_FC" --with-farcaster
test -f "$SYS_FC/.config/systemd/user/trenchcoat-job-farcaster-scan.service"
test -f "$SYS_FC/.config/systemd/user/trenchcoat-job-farcaster-scan.timer"
test -f "$SYS_FC/.config/systemd/user/trenchcoat-job-fc-source-review.service"

LD_FC="$TMP/ld-fc"
materialize_launchd "$LD_FC" --with-farcaster
test -f "$LD_FC/Library/LaunchAgents/com.trenchcoat.job.farcaster-scan.plist"
test -f "$LD_FC/Library/LaunchAgents/com.trenchcoat.job.fc-source-review.plist"

echo "== pump-scan scheduled =="
test -f "$SYS_WITH/.config/systemd/user/trenchcoat-job-pump-scan.service"
test -f "$SYS_WITH/.config/systemd/user/trenchcoat-job-pump-scan.timer"
test -f "$LD_WITH/Library/LaunchAgents/com.trenchcoat.job.pump-scan.plist"

echo "ALL_OK"
