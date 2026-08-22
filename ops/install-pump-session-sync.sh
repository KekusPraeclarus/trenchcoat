#!/bin/sh
# Install only the Mac pump.fun session sync LaunchAgent.
# Does not load production trenchcoat jobs. VPS stays the collector host.
# Usage: ops/install-pump-session-sync.sh [--dry-run] [--no-load] [--unload]
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
HOME="${HOME:-$(cd ~ && pwd)}"
BIN_DIR="$HOME/.trenchcoat/bin"
DEST="$HOME/Library/LaunchAgents"
LABEL="com.trenchcoat.pump-session-sync"
PLIST="$DEST/$LABEL.plist"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"
DRY_RUN=0
NO_LOAD=0
UNLOAD=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-load) NO_LOAD=1 ;;
    --unload) UNLOAD=1 ;;
    *) echo "usage: $0 [--dry-run] [--no-load] [--unload]" >&2; exit 2 ;;
  esac
done

copy_exec() {
  src="$1"
  dest="$2"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would copy $src → $dest"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  chmod 755 "$dest"
  echo "copied $dest"
}

if [ "$UNLOAD" -eq 1 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would bootout $DOMAIN/$LABEL"
    exit 0
  fi
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  echo "unloaded $LABEL"
  exit 0
fi

copy_exec "$REPO_ROOT/ops/sync-pump-session.sh" "$BIN_DIR/sync-pump-session"
copy_exec "$REPO_ROOT/ops/load-ssh-host.sh" "$BIN_DIR/load-ssh-host.sh"
copy_exec "$REPO_ROOT/ops/refresh-pump-session.mjs" "$BIN_DIR/refresh-pump-session.mjs"
if [ -f "$REPO_ROOT/.trenchcoat-local/ssh-host" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would copy $REPO_ROOT/.trenchcoat-local/ssh-host → $HOME/.trenchcoat/ssh-host"
  else
    mkdir -p "$HOME/.trenchcoat"
    cp "$REPO_ROOT/.trenchcoat-local/ssh-host" "$HOME/.trenchcoat/ssh-host"
    chmod 600 "$HOME/.trenchcoat/ssh-host"
    echo "copied $HOME/.trenchcoat/ssh-host"
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "would write $PLIST (RunAtLoad + 86400s)"
  exit 0
fi

mkdir -p "$DEST"
cp "$REPO_ROOT/ops/launchd/com.trenchcoat.pump-session-sync.plist" "$PLIST"
echo "wrote $PLIST"

if [ "$NO_LOAD" -eq 1 ]; then
  echo "files installed; launchd not loaded"
  exit 0
fi

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "loaded $LABEL (RunAtLoad now, then every 24h)"
echo "logs: /tmp/trenchcoat.pump-session-sync.out.log"
