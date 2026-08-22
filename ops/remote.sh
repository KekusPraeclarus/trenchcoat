#!/usr/bin/env bash
# Desktop → VPS operator entrypoint for **live** trenchcoat data and logs.
# Code lives in this git checkout on the Mac — do not SSH to browse the repo.
# Mac/agent initiates only (SSH out). Never opens inbound ports or copies secrets.
#
# Usage:
#   ops/remote.sh health
#   ops/remote.sh status
#   ops/remote.sh run narrative-scan
#   ops/remote.sh -- 'tail -50 /tmp/trenchcoat.x-scan.err.log'
#   ops/remote.sh sync
#
# Host: TRENCHCOAT_SSH_HOST, else gitignored .trenchcoat-local/ssh-host.
set -euo pipefail

REPO_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
# shellcheck source=ops/load-ssh-host.sh
. "$REPO_ROOT/ops/load-ssh-host.sh"
SYNC_DIR="$REPO_ROOT/.trenchcoat-remote"

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10)

remote_sh() {
  # Source host env on the VPS only — never print or pull ~/.trenchcoat/env
  ssh "${ssh_opts[@]}" "$HOST" "export PATH=\"\$HOME/.trenchcoat/bin:\$HOME/.local/bin:\$PATH\"; export XDG_RUNTIME_DIR=\"\${XDG_RUNTIME_DIR:-/run/user/\$(id -u)}\"; set -a; [ -f \"\$HOME/.trenchcoat/env\" ] && . \"\$HOME/.trenchcoat/env\"; set +a; $*"
}

remote_tc() {
  remote_sh "exec trenchcoat $(printf '%q ' "$@")"
}

cmd_health() {
  remote_sh 'echo "=== healthz ==="; curl -sS --max-time 3 http://127.0.0.1:8787/healthz || echo FAIL
echo
echo "=== keepalive ==="
systemctl --user is-active trenchcoat-router trenchcoat-listener trenchcoat-channels trenchcoat-x-scan
echo
echo "=== status ==="
trenchcoat status'
}

cmd_sync() {
  mkdir -p "$SYNC_DIR/agent/state" "$SYNC_DIR/agent/reports"
  # Non-secret operational views only. Profiles, env, sessions stay on the VPS.
  rsync -a --delete \
    -e "ssh ${ssh_opts[*]}" \
    "$HOST:.trenchcoat/config.json" \
    "$SYNC_DIR/config.json"

  rsync -a --delete \
    --exclude '.lock' \
    --exclude '.lock.owner' \
    -e "ssh ${ssh_opts[*]}" \
    "$HOST:.trenchcoat/agent/state/" \
    "$SYNC_DIR/agent/state/"

  rsync -a --delete \
    --max-size=2m \
    -e "ssh ${ssh_opts[*]}" \
    "$HOST:.trenchcoat/agent/reports/" \
    "$SYNC_DIR/agent/reports/" || true

  remote_sh 'trenchcoat status; echo; curl -sS --max-time 3 http://127.0.0.1:8787/healthz || true' \
    >"$SYNC_DIR/status.txt"

  printf 'synced → %s\n' "$SYNC_DIR"
  printf 'read: .trenchcoat-remote/status.txt, agent/state/, agent/reports/, config.json\n'
}

usage() {
  cat <<'EOF'
ops/remote.sh — live VPS access (desktop SSH out only)

  ops/remote.sh health              keepalive + healthz + status
  ops/remote.sh status|…            trenchcoat <args> on VPS
  ops/remote.sh -- <shell>          arbitrary remote command (env sourced)
  ops/remote.sh sync                pull non-secret state into .trenchcoat-remote/

Host: TRENCHCOAT_SSH_HOST, or gitignored .trenchcoat-local/ssh-host.
Never copies env, browser profiles, or session material.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ -z "$HOST" ]; then
  echo "set TRENCHCOAT_SSH_HOST, or write your SSH Host alias to .trenchcoat-local/ssh-host" >&2
  echo "see ops/ssh-host.example" >&2
  exit 2
fi

if [ "${1:-}" = "health" ]; then
  cmd_health
  exit 0
fi

if [ "${1:-}" = "sync" ]; then
  cmd_sync
  exit 0
fi

if [ "${1:-}" = "--" ]; then
  shift
  if [ "$#" -eq 0 ]; then
    echo "usage: ops/remote.sh -- <remote command>" >&2
    exit 2
  fi
  # Join remaining args as a remote script fragment
  remote_sh "$(printf '%q ' "$@")"
  exit 0
fi

if [ "$#" -eq 0 ]; then
  usage
  exit 2
fi

remote_tc "$@"
