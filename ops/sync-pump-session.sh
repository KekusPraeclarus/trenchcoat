#!/bin/sh
# Refresh the Mac pump.fun burner session and push storage-state.json to the VPS.
# Catch-up is launchd RunAtLoad + StartInterval 86400. This script has no clock gate.
# Copy only storage-state.json. Never copy import files or print cookie values.
set -eu

HOME="${HOME:-$(cd ~ && pwd)}"
_tc_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
if [ -f "$_tc_dir/../ops/load-ssh-host.sh" ]; then
  REPO_ROOT="$(CDPATH= cd -- "$_tc_dir/.." && pwd)"
  # shellcheck source=ops/load-ssh-host.sh
  . "$REPO_ROOT/ops/load-ssh-host.sh"
elif [ -f "$_tc_dir/load-ssh-host.sh" ]; then
  REPO_ROOT="${TRENCHCOAT_REPO_ROOT:-}"
  # shellcheck source=ops/load-ssh-host.sh
  . "$_tc_dir/load-ssh-host.sh"
else
  HOST="${TRENCHCOAT_SSH_HOST:-}"
fi
unset _tc_dir
BIN_DIR="${TRENCHCOAT_BIN_DIR:-$HOME/.trenchcoat/bin}"
STATE="$HOME/.trenchcoat/pump-profile/storage-state.json"
if [ -z "${HOST:-}" ]; then
  echo "set TRENCHCOAT_SSH_HOST, or write your SSH Host alias to .trenchcoat-local/ssh-host" >&2
  echo "see ops/ssh-host.example" >&2
  exit 2
fi
REFRESH_JS="${TRENCHCOAT_PUMP_REFRESH_JS:-$BIN_DIR/refresh-pump-session.mjs}"
DO_REFRESH=1
DO_PUSH=1

for arg in "$@"; do
  case "$arg" in
    --no-refresh) DO_REFRESH=0 ;;
    --no-push) DO_PUSH=0 ;;
    --refresh-only) DO_PUSH=0 ;;
    --push-only) DO_REFRESH=0 ;;
    *) echo "usage: $0 [--no-refresh|--no-push|--refresh-only|--push-only]" >&2; exit 2 ;;
  esac
done

if [ ! -f "$STATE" ]; then
  echo "No pump.fun session at $STATE" >&2
  exit 2
fi

if [ "$DO_REFRESH" -eq 1 ]; then
  if [ ! -f "$REFRESH_JS" ]; then
    echo "refresh skipped: $REFRESH_JS is missing"
  else
    set +e
    /usr/bin/env node "$REFRESH_JS"
    refresh_rc=$?
    set -e
    if [ "$refresh_rc" -eq 3 ]; then
      echo "refresh skipped: playwright missing"
    elif [ "$refresh_rc" -ne 0 ]; then
      echo "refresh did not restore an authenticated session (exit $refresh_rc)"
    fi
  fi
fi

authed="$(TRENCHCOAT_PUMP_STATE="$STATE" /usr/bin/env node --input-type=module -e "
import { readFileSync } from 'node:fs'
const raw = JSON.parse(readFileSync(process.env.TRENCHCOAT_PUMP_STATE, 'utf8'))
const cookies = Array.isArray(raw.cookies) ? raw.cookies : []
const origins = Array.isArray(raw.origins) ? raw.origins : []
const identity = /^(privy-token|privy-id-token|privy-access-token)\$/iu
const cookieAuth = cookies.some((c) => identity.test(String(c.name ?? '')) && String(c.value ?? '').length > 20)
const originAuth = origins.some((o) => (o.localStorage ?? []).some((i) => /privy/iu.test(String(i.name ?? '')) && String(i.value ?? '').length > 40))
const localNames = new Set(origins.flatMap((o) => (o.localStorage ?? []).map((i) => i.name)))
const identityCount = cookies.filter((c) => identity.test(String(c.name ?? ''))).length
console.log(['looks_authed=' + (cookieAuth || originAuth), 'cookies=' + cookies.length, 'identity_cookies=' + identityCount, 'localStorage=' + localNames.size].join(' '))
process.exit(cookieAuth || originAuth ? 0 : 2)
")" || {
  echo "session not authenticated; skip VPS push"
  echo "$authed"
  exit 2
}
echo "$authed"

if [ "$DO_PUSH" -eq 0 ]; then
  echo "push skipped"
  exit 0
fi

ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" \
  'mkdir -p ~/.trenchcoat/pump-profile && chmod 700 ~/.trenchcoat/pump-profile'
rsync -a -e "ssh -o BatchMode=yes -o ConnectTimeout=10" \
  "$STATE" "$HOST:.trenchcoat/pump-profile/storage-state.json"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" \
  'chmod 600 ~/.trenchcoat/pump-profile/storage-state.json'
echo "pushed storage-state.json to $HOST"
