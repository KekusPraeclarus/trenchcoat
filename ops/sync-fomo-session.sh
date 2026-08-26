#!/bin/sh
# Push Mac Fomo burner storage-state.json to the VPS.
# Copy only storage-state.json. Never copy the Chrome profile. Never print cookie values.
set -eu

HOME="${HOME:-$(cd ~ && pwd)}"
_tc_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$_tc_dir/.." && pwd)"
# shellcheck source=ops/load-ssh-host.sh
. "$REPO_ROOT/ops/load-ssh-host.sh"
unset _tc_dir

STATE="$HOME/.trenchcoat/fomo-profile/storage-state.json"
if [ -z "${HOST:-}" ]; then
  echo "set TRENCHCOAT_SSH_HOST, or write your SSH Host alias to .trenchcoat-local/ssh-host" >&2
  echo "see ops/ssh-host.example" >&2
  exit 2
fi
if [ ! -f "$STATE" ]; then
  echo "No Fomo session at $STATE" >&2
  echo "Run: pnpm dev:cli auth fomo" >&2
  exit 2
fi

authed="$(TRENCHCOAT_FOMO_STATE="$STATE" /usr/bin/env node --input-type=module -e "
import { readFileSync } from 'node:fs'
const raw = JSON.parse(readFileSync(process.env.TRENCHCOAT_FOMO_STATE, 'utf8'))
const cookies = Array.isArray(raw.cookies) ? raw.cookies : []
const origins = Array.isArray(raw.origins) ? raw.origins : []
const identity = /privy|session|token/iu
const cookieAuth = cookies.some((c) => identity.test(String(c.name ?? '')) && String(c.value ?? '').length > 8)
const originAuth = origins.some((o) => (o.localStorage ?? []).some((i) => /privy/iu.test(String(i.name ?? '')) && String(i.value ?? '').length > 40))
console.log(['looks_authed=' + (cookieAuth || originAuth), 'cookies=' + cookies.length].join(' '))
process.exit(cookieAuth || originAuth ? 0 : 2)
")" || {
  echo "session not authenticated; skip VPS push"
  echo "$authed"
  exit 2
}
echo "$authed"

ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" \
  'mkdir -p ~/.trenchcoat/fomo-profile && chmod 700 ~/.trenchcoat/fomo-profile'
rsync -a -e "ssh -o BatchMode=yes -o ConnectTimeout=10" \
  "$STATE" "$HOST:.trenchcoat/fomo-profile/storage-state.json"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" \
  'chmod 600 ~/.trenchcoat/fomo-profile/storage-state.json'
echo "pushed storage-state.json to $HOST"
