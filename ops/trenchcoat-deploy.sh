#!/usr/bin/env bash
# GitHub Actions / operator entrypoint: ff-only pull main, then Linux install.
# Desktop never inbound — Actions SSHs here and runs this script (or authorized_keys command=).
# Usage: ops/trenchcoat-deploy.sh
#        ~/bin/trenchcoat-deploy  (symlink or copy installed by install-systemd.sh)
set -euo pipefail

HOME="${HOME:-$(cd ~ && pwd)}"
REPO_ROOT="${TRENCHCOAT_REPO_ROOT:-$HOME/src/trenchcoat}"
LOCK="$HOME/.trenchcoat/repo-mutation.lock"
INSTALL="$REPO_ROOT/ops/install-systemd.sh"

export PATH="$HOME/.local/bin:$HOME/.trenchcoat/bin:$HOME/bin:/usr/local/bin:$PATH"
# User systemd from non-login SSH (Actions) needs the runtime dir
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi

if [ ! -d "$REPO_ROOT/.git" ]; then
  echo "missing git checkout at $REPO_ROOT (set TRENCHCOAT_REPO_ROOT)" >&2
  exit 1
fi
if [ ! -x "$INSTALL" ]; then
  echo "missing $INSTALL — pull a commit that includes Linux install support" >&2
  exit 1
fi

mkdir -p "$HOME/.trenchcoat"
chmod 700 "$HOME/.trenchcoat"
exec 9>"$LOCK"
if ! flock -w 600 9; then
  echo "could not acquire $LOCK within 600s" >&2
  exit 1
fi

cd "$REPO_ROOT"
git fetch origin
git checkout main
git pull --ff-only origin main

# Re-resolve after pull in case the script path changed
INSTALL="$REPO_ROOT/ops/install-systemd.sh"
exec "$INSTALL"
