#!/bin/sh
# Materialize ops/launchd templates into ~/Library/LaunchAgents and bootstrap them.
# Deploys a runtime copy under ~/.trenchcoat/runtime so launchd is not blocked by
# macOS TCC on ~/Documents.
# Usage: ops/install-launchd.sh [--dry-run] [--with-harness] [--jobs-only]
#                               [--no-load] [--sync-env] [--allow-dirty]
#   --sync-env  atomically copy repo .env → ~/.trenchcoat/env (mode 600) after
#               validating required key NAMES are present. If it is the only
#               argument, sync and exit 0 without redeploying; otherwise sync
#               before loading the launchd jobs.
#   --allow-dirty  acknowledge deploying from a dirty git tree. Default refuses
#               dirty working trees so deployment.json provenance stays exact.
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
HOME="${HOME:-$(cd ~ && pwd)}"
DEST="$HOME/Library/LaunchAgents"
ENV_FILE="$HOME/.trenchcoat/env"
AGENT_ROOT="$HOME/.trenchcoat/agent"
RUNTIME_ROOT="$HOME/.trenchcoat/runtime"
RUNTIME_STAGING="$HOME/.trenchcoat/runtime.next"
RUNTIME_PREVIOUS="$HOME/.trenchcoat/runtime.prev"
BIN_DIR="$HOME/.trenchcoat/bin"
TC="$BIN_DIR/trenchcoat"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"
DRY_RUN=0
WITH_HARNESS=0
JOBS_ONLY=0
NO_LOAD=0
SYNC_ENV=0
ALLOW_DIRTY=0
# Count non-sync args so `--sync-env` alone runs as a standalone sync
INSTALL_ARGS=0

# Required key NAMES for live ops (mirrors src/lib/preflight.ts). Presence is
# validated by name only — values are never read or printed. Optional keys in
# .env.example (router bot, telegram api, tavily, discord webhook) are not required.
REQUIRED_ENV_KEYS="TRENCHCOAT_ROUTER_URL TRENCHCOAT_ROUTER_TOKEN TRENCHCOAT_ROUTER_HMAC_KEY TELEGRAM_BOT_TOKEN TELEGRAM_OPERATOR_ID HELIUS_API_KEY INFURA_API_KEY NEYNAR_API_KEY GOPLUS_APP_KEY COINGECKO_DEMO_KEY"

for arg in "$@"; do
  case "$arg" in
    --sync-env) SYNC_ENV=1 ;;
    --dry-run) DRY_RUN=1; INSTALL_ARGS=$((INSTALL_ARGS + 1)) ;;
    --with-harness) WITH_HARNESS=1; INSTALL_ARGS=$((INSTALL_ARGS + 1)) ;;
    --jobs-only) JOBS_ONLY=1; INSTALL_ARGS=$((INSTALL_ARGS + 1)) ;;
    --no-load) NO_LOAD=1; INSTALL_ARGS=$((INSTALL_ARGS + 1)) ;;
    --allow-dirty) ALLOW_DIRTY=1; INSTALL_ARGS=$((INSTALL_ARGS + 1)) ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Refuse dirty deploys unless explicitly acknowledged (standalone --sync-env skips).
require_clean_source() {
  if ! git -C "$REPO_ROOT" rev-parse HEAD >/dev/null 2>&1; then
    echo "refusing deploy: $REPO_ROOT is not a git checkout (no commit provenance)" >&2
    exit 1
  fi
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
    if [ "$ALLOW_DIRTY" -eq 0 ]; then
      echo "refusing deploy: working tree is dirty" >&2
      echo "commit or stash changes, or pass --allow-dirty to acknowledge" >&2
      git -C "$REPO_ROOT" status --short >&2
      exit 1
    fi
    echo "WARNING: deploying dirty working tree (--allow-dirty acknowledged)" >&2
  fi
}

# Atomically sync repo .env → ~/.trenchcoat/env. Validates required key NAMES
# without reading values. Never writes under agent/.
sync_env() {
  src="$REPO_ROOT/.env"
  if [ ! -f "$src" ]; then
    echo "no repo .env to sync at $src" >&2
    exit 1
  fi
  missing=""
  for key in $REQUIRED_ENV_KEYS; do
    if ! grep -Eq "^[[:space:]]*${key}=" "$src"; then
      missing="$missing $key"
    fi
  done
  if [ -n "$missing" ]; then
    echo "repo .env missing required key names:$missing" >&2
    exit 1
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would sync repo .env → $ENV_FILE (mode 600, atomic)"
    return
  fi
  mkdir -p "$HOME/.trenchcoat"
  chmod 700 "$HOME/.trenchcoat" 2>/dev/null || true
  tmp="$ENV_FILE.next.$$"
  ( umask 077; cp "$src" "$tmp" )
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  echo "synced repo .env → $ENV_FILE (mode 600)"
}

# Standalone sync: `--sync-env` with no install flags syncs env and exits.
if [ "$SYNC_ENV" -eq 1 ] && [ "$INSTALL_ARGS" -eq 0 ]; then
  sync_env
  exit 0
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node not on PATH" >&2
  exit 1
fi

# & must be XML-escaped inside plist <string> nodes
WRAPPER_PREFIX="set -a; [ -f \"\$HOME/.trenchcoat/env\" ] &amp;&amp; . \"\$HOME/.trenchcoat/env\"; set +a"

deploy_runtime() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would deploy runtime → $RUNTIME_ROOT (via $RUNTIME_STAGING) and wrapper → $TC"
    echo "would write deployment.json schema=2 with commit/dirty/sourceHash/configSchema/artifact hashes"
    return
  fi
  (
    cd "$REPO_ROOT"
    # tsc does not delete removed outputs — wipe before build or deleted
    # collectors linger in dist/ and get copied into ~/.trenchcoat/runtime
    rm -rf dist
    if ! pnpm build; then
      echo "pnpm build failed — refusing to deploy stale dist" >&2
      exit 1
    fi
  )
  mkdir -p "$BIN_DIR"
  rm -rf "$RUNTIME_STAGING"
  mkdir -p "$RUNTIME_STAGING/dist"
  cp -R "$REPO_ROOT/dist/." "$RUNTIME_STAGING/dist/"
  cp "$REPO_ROOT/package.json" "$RUNTIME_STAGING/package.json"
  (
    cd "$RUNTIME_STAGING"
    # ignore-scripts skips lifecycle hooks for speed/safety, but better-sqlite3
    # (router SQLite) needs its native addon — rebuild that one explicitly
    pnpm install --prod --ignore-scripts --config.confirmModulesPurge=false >/dev/null
    pnpm rebuild better-sqlite3 >/dev/null
  )

  PKG_VERSION="$("$NODE_BIN" -e "console.log(require('$RUNTIME_STAGING/package.json').version)")"
  BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  SOURCE_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
  SOURCE_TREE="$(git -C "$REPO_ROOT" rev-parse 'HEAD^{tree}' 2>/dev/null || true)"
  SOURCE_PORCELAIN="$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null || true)"
  if [ -n "$SOURCE_PORCELAIN" ]; then
    SOURCE_DIRTY_JSON=true
  else
    SOURCE_DIRTY_JSON=false
  fi
  if [ -n "$SOURCE_COMMIT" ]; then
    COMMIT_JSON="\"$SOURCE_COMMIT\""
  else
    COMMIT_JSON="null"
  fi
  if [ -n "$SOURCE_TREE" ]; then
    TREE_JSON="\"$SOURCE_TREE\""
  else
    TREE_JSON="null"
  fi
  # Diff vs HEAD (staged + unstaged). Untracked paths appear in porcelain only.
  SOURCE_DIFF="$(git -C "$REPO_ROOT" diff HEAD 2>/dev/null || true)"
  # configSchema must match DEPLOYMENT_CONFIG_SCHEMA / live config schema (9)
  # Temp files avoid shell/env quoting limits for large dirty diffs
  PROV_DIR="$RUNTIME_STAGING/.provenance"
  mkdir -p "$PROV_DIR"
  printf '%s' "$SOURCE_PORCELAIN" >"$PROV_DIR/porcelain"
  printf '%s' "$SOURCE_DIFF" >"$PROV_DIR/diff"
  "$NODE_BIN" --input-type=module <<EOF
import { writeFileSync, readFileSync, rmSync } from "node:fs"
import { createHash } from "node:crypto"
const cli = readFileSync("$RUNTIME_STAGING/dist/cli.js")
const cfg = readFileSync("$RUNTIME_STAGING/dist/lib/config.js")
const sha = (buf) => "sha256:" + createHash("sha256").update(buf).digest("hex")
const sourceCommit = $COMMIT_JSON
const treeOid = $TREE_JSON
const sourceDirty = $SOURCE_DIRTY_JSON
const porcelain = readFileSync("$PROV_DIR/porcelain", "utf8")
const diff = readFileSync("$PROV_DIR/diff", "utf8")
const h = createHash("sha256")
h.update("commit:" + (sourceCommit ?? "null") + "\\n")
h.update("tree:" + (treeOid ?? "null") + "\\n")
h.update("dirty:" + (sourceDirty ? "1" : "0") + "\\n")
h.update(porcelain)
h.update("\\n---\\n")
h.update(diff)
const sourceHash = "sha256:" + h.digest("hex")
const manifest = {
  schema: 2,
  builtAt: "$BUILT_AT",
  packageVersion: "$PKG_VERSION",
  configSchema: 9,
  sourceCommit,
  sourceDirty,
  sourceHash,
  cliHash: sha(cli),
  configModuleHash: sha(cfg),
}
writeFileSync("$RUNTIME_STAGING/deployment.json", JSON.stringify(manifest, null, 2) + "\\n", { mode: 0o600 })
rmSync("$PROV_DIR", { recursive: true, force: true })
console.log(
  "deployment provenance commit=" + (sourceCommit ? sourceCommit.slice(0, 12) : "none")
    + " dirty=" + sourceDirty
    + " sourceHash=" + sourceHash.slice(0, 19)
    + " configSchema=9",
)
EOF

  STAGED_TC="$BIN_DIR/trenchcoat.staging"
  cat >"$STAGED_TC" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$RUNTIME_STAGING/dist/cli.js" "\$@"
EOF
  chmod 755 "$STAGED_TC"
  if ! "$STAGED_TC" config validate >/dev/null; then
    echo "staged runtime failed config validate — leaving active runtime untouched" >&2
    rm -f "$STAGED_TC"
    rm -rf "$RUNTIME_STAGING"
    exit 1
  fi

  rm -rf "$RUNTIME_PREVIOUS"
  if [ -d "$RUNTIME_ROOT" ]; then
    mv "$RUNTIME_ROOT" "$RUNTIME_PREVIOUS"
  fi
  mv "$RUNTIME_STAGING" "$RUNTIME_ROOT"
  cat >"$TC" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$RUNTIME_ROOT/dist/cli.js" "\$@"
EOF
  chmod 755 "$TC"
  rm -f "$STAGED_TC"

  if [ -f "$HOME/.trenchcoat/config.json" ]; then
    mkdir -p "$HOME/.trenchcoat/backups"
    cp "$HOME/.trenchcoat/config.json" "$HOME/.trenchcoat/backups/config-$(date -u +%Y%m%dT%H%M%SZ).json"
    chmod 600 "$HOME/.trenchcoat/backups"/config-*.json 2>/dev/null || true
    "$TC" config migrate --write >/dev/null
  fi

  cp "$REPO_ROOT/ops/run-job-jittered.sh" "$BIN_DIR/run-job-jittered"
  cp "$REPO_ROOT/ops/run-with-lock-retry.sh" "$BIN_DIR/run-with-lock-retry"
  cp "$REPO_ROOT/ops/run-precheck.sh" "$BIN_DIR/run-precheck"
  chmod 755 "$BIN_DIR/run-job-jittered" "$BIN_DIR/run-with-lock-retry" "$BIN_DIR/run-precheck"
  for job in list-scan farcaster-scan; do
    cat >"$BIN_DIR/run-$job" <<EOF
#!/bin/sh
exec "$BIN_DIR/run-job-jittered" $job
EOF
    chmod 755 "$BIN_DIR/run-$job"
  done
  echo "deployed runtime → $RUNTIME_ROOT"
  echo "wrapper → $TC"
  echo "jitter gates → $BIN_DIR/run-list-scan, $BIN_DIR/run-farcaster-scan"
  echo "lock retry → $BIN_DIR/run-with-lock-retry"
  echo "precheck → $BIN_DIR/run-precheck"
}

write_interval_plist() {
  label="$1"
  job="$2"
  seconds="$3"
  use_precheck="${4:-0}"
  runner="$BIN_DIR/run-with-lock-retry"
  if [ "$use_precheck" -eq 1 ]; then
    runner="$BIN_DIR/run-precheck"
  fi
  out="$DEST/$label.plist"
  body=$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>$WRAPPER_PREFIX; exec $runner $job</string>
  </array>
  <key>StartInterval</key>
  <integer>$seconds</integer>
  <key>StandardOutPath</key>
  <string>/tmp/trenchcoat.$job.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/trenchcoat.$job.err.log</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF
)
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would write $out ($job every ${seconds}s${use_precheck:+, precheck})"
    return
  fi
  printf '%s\n' "$body" >"$out"
  echo "wrote $out"
}

# Social scans: launchd polls; ops/run-job-jittered.sh gates to ~4h ± 45m
write_jittered_job_plist() {
  job="$1"
  label="com.trenchcoat.job.$job"
  poll_seconds=900
  wrapper="$BIN_DIR/run-$job"
  out="$DEST/$label.plist"
  body=$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>$WRAPPER_PREFIX; exec $wrapper</string>
  </array>
  <key>StartInterval</key>
  <integer>$poll_seconds</integer>
  <key>StandardOutPath</key>
  <string>/tmp/trenchcoat.$job.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/trenchcoat.$job.err.log</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF
)
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would write $out ($job jittered 3h15m–4h45m, poll ${poll_seconds}s)"
    return
  fi
  printf '%s\n' "$body" >"$out"
  echo "wrote $out"
}

write_calendar_plist() {
  label="$1"
  job="$2"
  hour="$3"
  minute="$4"
  weekday="${5:-}"
  out="$DEST/$label.plist"
  weekday_xml=""
  if [ -n "$weekday" ]; then
    weekday_xml="
    <key>Weekday</key>
    <integer>$weekday</integer>"
  fi
  body=$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>$WRAPPER_PREFIX; exec $BIN_DIR/run-precheck $job</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>$hour</integer>
    <key>Minute</key>
    <integer>$minute</integer>$weekday_xml
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/trenchcoat.$job.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/trenchcoat.$job.err.log</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF
)
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would write $out ($job calendar)"
    return
  fi
  printf '%s\n' "$body" >"$out"
  echo "wrote $out"
}

write_listener_plist() {
  out="$DEST/com.trenchcoat.listener.plist"
  body=$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.trenchcoat.listener</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>$WRAPPER_PREFIX; exec $TC listen</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>/tmp/trenchcoat.listener.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/trenchcoat.listener.err.log</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF
)
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would write $out (KeepAlive listener)"
    return
  fi
  printf '%s\n' "$body" >"$out"
  echo "wrote $out"
}

write_channels_listener_plist() {
  out="$DEST/com.trenchcoat.channels.plist"
  body=$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.trenchcoat.channels</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>$WRAPPER_PREFIX; exec $TC listen channels</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>/tmp/trenchcoat.channels.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/trenchcoat.channels.err.log</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF
)
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would write $out (KeepAlive channel listener)"
    return
  fi
  printf '%s\n' "$body" >"$out"
  echo "wrote $out"
}

retire_discord_listener_plist() {
  label="com.trenchcoat.discord-listener"
  out="$DEST/$label.plist"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would bootout and remove legacy $label (discord now runs under com.trenchcoat.listener)"
    return
  fi
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  if [ -f "$out" ]; then
    rm -f "$out"
    echo "removed legacy $out (discord runs under com.trenchcoat.listener)"
  fi
}

write_discord_watchlist_scan_plist() {
  out="$DEST/com.trenchcoat.job.discord-watchlist-scan.plist"
  body=$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.trenchcoat.job.discord-watchlist-scan</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>$WRAPPER_PREFIX; exec $TC discord watchlist scan</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>0</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key>
  <string>/tmp/trenchcoat.discord-watchlist-scan.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/trenchcoat.discord-watchlist-scan.err.log</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF
)
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would write $out (discord watchlist scan calendar 0/6/12/18)"
    return
  fi
  printf '%s\n' "$body" >"$out"
  echo "wrote $out"
}

write_router_plist() {
  out="$DEST/com.trenchcoat.router.plist"
  body=$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.trenchcoat.router</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>$WRAPPER_PREFIX; exec $TC router serve</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>/tmp/trenchcoat.router.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/trenchcoat.router.err.log</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF
)
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would write $out (KeepAlive router)"
    return
  fi
  printf '%s\n' "$body" >"$out"
  echo "wrote $out"
}

write_backup_plist() {
  out="$DEST/com.trenchcoat.backup.plist"
  body=$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.trenchcoat.backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$REPO_ROOT/ops/backup.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>0</integer>
    <key>Hour</key>
    <integer>5</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/trenchcoat.backup.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/trenchcoat.backup.err.log</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF
)
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would write $out (weekly Sun 05:00)"
    return
  fi
  printf '%s\n' "$body" >"$out"
  echo "wrote $out"
}

bootstrap_label() {
  label="$1"
  plist="$DEST/$label.plist"
  if [ "$NO_LOAD" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then
    echo "skip load $label"
    return
  fi
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  # brief settle avoids "Bootstrap failed: 5" when the prior process is still dying
  sleep 0.3
  if ! launchctl bootstrap "$DOMAIN" "$plist" 2>/dev/null; then
    launchctl kickstart -k "$DOMAIN/$label" 2>/dev/null \
      || launchctl bootstrap "$DOMAIN" "$plist"
  fi
  launchctl enable "$DOMAIN/$label" 2>/dev/null || true
  echo "loaded $label"
}

# --- host prep ---
if [ "$DRY_RUN" -eq 0 ]; then
  mkdir -p "$DEST" "$HOME/.trenchcoat/backups"
  chmod 700 "$HOME/.trenchcoat" 2>/dev/null || true
  if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$REPO_ROOT/.env" ]; then
      cp "$REPO_ROOT/.env" "$ENV_FILE"
      chmod 600 "$ENV_FILE"
      echo "copied repo .env → $ENV_FILE (mode 600)"
    elif [ -f "$REPO_ROOT/.env.example" ]; then
      cp "$REPO_ROOT/.env.example" "$ENV_FILE"
      chmod 600 "$ENV_FILE"
      echo "copied .env.example → $ENV_FILE — fill secrets before relying on jobs"
    else
      echo "missing $ENV_FILE — create it (mode 600) before loading" >&2
      exit 1
    fi
  fi
  if [ -d "$AGENT_ROOT" ] && [ ! -d "$AGENT_ROOT/.git" ]; then
    (
      cd "$AGENT_ROOT"
      git init
      git config user.email "trenchcoat-backup@localhost"
      git config user.name "trenchcoat-backup"
      git add -A
      git diff --cached --quiet || git commit -m "initial agent workspace"
    )
    echo "initialized git in $AGENT_ROOT"
  fi
  chmod +x "$REPO_ROOT/ops/backup.sh" "$REPO_ROOT/ops/install-launchd.sh"
fi

# --sync-env alongside install: refresh env atomically before deploy/load
if [ "$SYNC_ENV" -eq 1 ]; then
  sync_env
fi

require_clean_source
deploy_runtime
if [ ! -x "$TC" ] && [ "$DRY_RUN" -eq 0 ]; then
  echo "runtime wrapper missing: $TC" >&2
  exit 1
fi

# Cadences from ops/runbook.md (+ wallet jobs from procedures)
# 4th arg 1 = host precondition precheck before lock (chart/watchlist/research/wallets)
write_interval_plist com.trenchcoat.job.chart-sweep chart-sweep 3600 1
write_interval_plist com.trenchcoat.job.watchlist-scan watchlist-scan 7200 1
write_jittered_job_plist list-scan
write_jittered_job_plist farcaster-scan
write_interval_plist com.trenchcoat.job.narrative-scan narrative-scan 21600
write_interval_plist com.trenchcoat.job.research research 3600 1
write_interval_plist com.trenchcoat.job.source-list-review source-list-review 86400
write_interval_plist com.trenchcoat.job.fc-source-review fc-source-review 86400
write_calendar_plist com.trenchcoat.job.review review 7 0
write_calendar_plist com.trenchcoat.job.audit audit 6 0 1
write_interval_plist com.trenchcoat.job.wallet-discovery wallet-discovery 21600 1
write_interval_plist com.trenchcoat.job.wallet-scan-solana wallet-scan-solana 300 1
write_interval_plist com.trenchcoat.job.wallet-scan-evm wallet-scan-evm 900 1
write_interval_plist com.trenchcoat.job.wallet-review wallet-review 86400
write_interval_plist com.trenchcoat.job.fomo-trader-sync fomo-trader-sync 86400 1
write_interval_plist com.trenchcoat.job.fomo-signal-scan fomo-signal-scan 1800 1
write_interval_plist com.trenchcoat.job.fomo-x-source-review fomo-x-source-review 21600 1
write_interval_plist com.trenchcoat.job.fomo-narrative-source-scan fomo-narrative-source-scan 21600 1
write_interval_plist com.trenchcoat.job.narrative-source-review narrative-source-review 86400 1
write_interval_plist com.trenchcoat.job.delivery-retry delivery-retry 900 1
write_discord_watchlist_scan_plist

if [ "$JOBS_ONLY" -eq 0 ]; then
  write_listener_plist
  write_channels_listener_plist
  retire_discord_listener_plist
  write_router_plist
  write_backup_plist
fi

if [ "$WITH_HARNESS" -eq 1 ]; then
  write_interval_plist com.trenchcoat.job.harness-improve harness-improve 604800
fi

# Load
for label in \
  com.trenchcoat.job.chart-sweep \
  com.trenchcoat.job.watchlist-scan \
  com.trenchcoat.job.list-scan \
  com.trenchcoat.job.farcaster-scan \
  com.trenchcoat.job.narrative-scan \
  com.trenchcoat.job.research \
  com.trenchcoat.job.source-list-review \
  com.trenchcoat.job.fc-source-review \
  com.trenchcoat.job.review \
  com.trenchcoat.job.audit \
  com.trenchcoat.job.wallet-discovery \
  com.trenchcoat.job.wallet-scan-solana \
  com.trenchcoat.job.wallet-scan-evm \
  com.trenchcoat.job.wallet-review \
  com.trenchcoat.job.fomo-trader-sync \
  com.trenchcoat.job.fomo-signal-scan \
  com.trenchcoat.job.fomo-x-source-review \
  com.trenchcoat.job.fomo-narrative-source-scan \
  com.trenchcoat.job.narrative-source-review \
  com.trenchcoat.job.delivery-retry \
  com.trenchcoat.job.discord-watchlist-scan
do
  bootstrap_label "$label"
done

if [ "$JOBS_ONLY" -eq 0 ]; then
  bootstrap_label com.trenchcoat.listener
  bootstrap_label com.trenchcoat.channels
  bootstrap_label com.trenchcoat.router
  bootstrap_label com.trenchcoat.backup
fi

if [ "$WITH_HARNESS" -eq 1 ]; then
  bootstrap_label com.trenchcoat.job.harness-improve
fi

echo "done. trenchcoat=$TC (runtime under $RUNTIME_ROOT)"
echo "logs: /tmp/trenchcoat.*.log"
echo "listener keepalive: launchctl print $DOMAIN/com.trenchcoat.listener (telegram + discord when enabled)"
echo "channels keepalive: launchctl print $DOMAIN/com.trenchcoat.channels"
echo "router keepalive: launchctl print $DOMAIN/com.trenchcoat.router"
echo "backup (manual smoke): $REPO_ROOT/ops/backup.sh"
echo "re-run this script after pulling code changes that affect the CLI"
