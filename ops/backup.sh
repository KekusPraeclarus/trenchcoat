#!/bin/sh
# Weekly backup: commit+push ~/.trenchcoat/agent, then archive manifest via tc backup.
# Invoked by launchd com.trenchcoat.backup. Failures are non-zero for launchd logs.
set -eu

HOME="${HOME:-$(cd ~ && pwd)}"
ENV_FILE="$HOME/.trenchcoat/env"
AGENT_ROOT="$HOME/.trenchcoat/agent"
TC="$HOME/.trenchcoat/bin/trenchcoat"
export PATH="$HOME/.trenchcoat/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

if [ ! -x "$TC" ]; then
  echo "missing $TC — run ops/install-launchd.sh first" >&2
  exit 1
fi

if [ ! -d "$AGENT_ROOT" ]; then
  echo "missing agent root: $AGENT_ROOT" >&2
  exit 1
fi

cd "$AGENT_ROOT"
if [ ! -d .git ]; then
  git init
  git config user.email "trenchcoat-backup@localhost"
  git config user.name "trenchcoat-backup"
fi

git add -A
if ! git diff --cached --quiet; then
  git commit -m "backup $(date -u +%Y-%m-%dT%H%M%SZ)"
fi

if git remote get-url origin >/dev/null 2>&1; then
  git push origin HEAD
else
  echo "note: no git remote on $AGENT_ROOT — local commits only; add a private origin for off-box backup"
fi

exec "$TC" backup
