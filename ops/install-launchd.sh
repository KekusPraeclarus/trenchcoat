#!/bin/sh
# Materialize ops/launchd templates into ~/Library/LaunchAgents and bootstrap them.
# Deploys a runtime copy under ~/.trenchcoat/runtime so launchd is not blocked by
# macOS TCC on ~/Documents.
# Usage: ops/install-launchd.sh [--dry-run] [--without-harness] [--jobs-only]
#                               [--no-load] [--sync-env] [--sync-skills] [--allow-dirty]
#                               [--skip-agent-wait]
#   --without-harness  skip installing the weekly harness-improve job (on by default)
#   --sync-env  atomically copy repo .env → ~/.trenchcoat/env (mode 600) after
#               validating required key NAMES are present. If it is the only
#               argument, sync and exit 0 without redeploying; otherwise sync
#               before loading the launchd jobs.
#   --sync-skills  rsync repo agent/skills/ + agent/AGENTS.md into
#               ~/.trenchcoat/agent/ (and ~/.trenchcoat/discord/agent/ when present).
#               Alone with --sync-env: sync both and exit. Alone: sync skills and exit.
#   --allow-dirty  acknowledge deploying from a dirty git tree. Default refuses
#               dirty working trees so deployment.json provenance stays exact.
#   --skip-agent-wait  do not wait for in-flight agent/host jobs before
#               bootout/kickstart (unsafe; can kill mid-session).
# Deploy pause: writes ~/.trenchcoat/deploy-pause.json early so cron/KeepAlive
# jobs defer (exit 3 / wait) until reload finishes, then clears the pause and
# kickstarts any deferred jobs.
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
HOME="${HOME:-$(cd ~ && pwd)}"
DEST="$HOME/Library/LaunchAgents"
ENV_FILE="$HOME/.trenchcoat/env"
AGENT_ROOT="$HOME/.trenchcoat/agent"
DISCORD_AGENT_ROOT="$HOME/.trenchcoat/discord/agent"
RUNTIME_ROOT="$HOME/.trenchcoat/runtime"
RUNTIME_STAGING="$HOME/.trenchcoat/runtime.next"
RUNTIME_PREVIOUS="$HOME/.trenchcoat/runtime.prev"
BIN_DIR="$HOME/.trenchcoat/bin"
TC="$BIN_DIR/trenchcoat"
PAUSE_FILE="$HOME/.trenchcoat/deploy-pause.json"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"
DRY_RUN=0
WITH_HARNESS=1
JOBS_ONLY=0
NO_LOAD=0
SYNC_ENV=0
SYNC_SKILLS=0
ALLOW_DIRTY=0
SKIP_AGENT_WAIT=0
PAUSE_ACTIVE=0
# Count non-sync args so `--sync-env` / `--sync-skills` alone run as standalone sync
INSTALL_ARGS=0

# Required key NAMES for live ops (mirrors src/lib/preflight.ts). Presence is
# validated by name only — values are never read or printed. Optional keys in
# .env.example (router bot, telegram api, tavily, discord webhook) are not required.
REQUIRED_ENV_KEYS="TRENCHCOAT_ROUTER_URL TRENCHCOAT_ROUTER_TOKEN TRENCHCOAT_ROUTER_HMAC_KEY TELEGRAM_BOT_TOKEN TELEGRAM_OPERATOR_ID HELIUS_API_KEY INFURA_API_KEY NEYNAR_API_KEY GOPLUS_APP_KEY COINGECKO_DEMO_KEY"

for arg in "$@"; do
  case "$arg" in
    --sync-env) SYNC_ENV=1 ;;
    --sync-skills) SYNC_SKILLS=1 ;;
    --dry-run) DRY_RUN=1; INSTALL_ARGS=$((INSTALL_ARGS + 1)) ;;
    --without-harness) WITH_HARNESS=0; INSTALL_ARGS=$((INSTALL_ARGS + 1)) ;;
    --with-harness) WITH_HARNESS=1; INSTALL_ARGS=$((INSTALL_ARGS + 1)) ;;
    --jobs-only) JOBS_ONLY=1; INSTALL_ARGS=$((INSTALL_ARGS + 1)) ;;
    --no-load) NO_LOAD=1; INSTALL_ARGS=$((INSTALL_ARGS + 1)) ;;
    --allow-dirty) ALLOW_DIRTY=1; INSTALL_ARGS=$((INSTALL_ARGS + 1)) ;;
    --skip-agent-wait) SKIP_AGENT_WAIT=1; INSTALL_ARGS=$((INSTALL_ARGS + 1)) ;;
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

# Persist the checkout path harness-improve needs (launchd has no WorkingDirectory).
upsert_repo_root_env() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would set TRENCHCOAT_REPO_ROOT=$REPO_ROOT in $ENV_FILE"
    return
  fi
  if [ ! -f "$ENV_FILE" ]; then
    echo "missing $ENV_FILE — cannot set TRENCHCOAT_REPO_ROOT" >&2
    exit 1
  fi
  tmp="$ENV_FILE.repo.$$"
  if grep -Eq '^[[:space:]]*TRENCHCOAT_REPO_ROOT=' "$ENV_FILE"; then
    sed "s|^[[:space:]]*TRENCHCOAT_REPO_ROOT=.*|TRENCHCOAT_REPO_ROOT=$REPO_ROOT|" "$ENV_FILE" >"$tmp"
  else
    cat "$ENV_FILE" >"$tmp"
    printf '\n# Git checkout for harness-improve (launchd cwd is unreliable)\nTRENCHCOAT_REPO_ROOT=%s\n' "$REPO_ROOT" >>"$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  echo "TRENCHCOAT_REPO_ROOT → $REPO_ROOT"
}

# Copy repo agent instructions + skills into the live agent workspace.
# Never writes inbox/outbox/state — skills and AGENTS.md only.
sync_skills() {
  src_skills="$REPO_ROOT/agent/skills"
  src_agents="$REPO_ROOT/agent/AGENTS.md"
  if [ ! -d "$src_skills" ]; then
    echo "missing $src_skills" >&2
    exit 1
  fi
  if [ ! -f "$src_agents" ]; then
    echo "missing $src_agents" >&2
    exit 1
  fi
  sync_one_agent_skills() {
    dest_root="$1"
    label="$2"
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "would sync skills + AGENTS.md → $dest_root ($label)"
      return
    fi
    mkdir -p "$dest_root/skills"
    chmod 700 "$dest_root" "$dest_root/skills" 2>/dev/null || true
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --delete "$src_skills/" "$dest_root/skills/"
    else
      rm -rf "$dest_root/skills"
      mkdir -p "$dest_root/skills"
      cp -R "$src_skills/." "$dest_root/skills/"
    fi
    cp "$src_agents" "$dest_root/AGENTS.md"
    chmod -R u+rwX,go-rwx "$dest_root/skills" "$dest_root/AGENTS.md" 2>/dev/null || true
    echo "synced skills + AGENTS.md → $dest_root ($label)"
  }
  sync_one_agent_skills "$AGENT_ROOT" "main"
  if [ -d "$DISCORD_AGENT_ROOT" ] || [ -d "$HOME/.trenchcoat/discord" ]; then
    sync_one_agent_skills "$DISCORD_AGENT_ROOT" "discord"
  fi
}

# Standalone sync: `--sync-env` / `--sync-skills` with no install flags sync and exit.
if [ "$INSTALL_ARGS" -eq 0 ] && { [ "$SYNC_ENV" -eq 1 ] || [ "$SYNC_SKILLS" -eq 1 ]; }; then
  if [ "$SYNC_ENV" -eq 1 ]; then
    sync_env
    upsert_repo_root_env
  fi
  if [ "$SYNC_SKILLS" -eq 1 ]; then
    sync_skills
  fi
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
  # configSchema must match DEPLOYMENT_CONFIG_SCHEMA / live config schema (11)
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
  configSchema: 11,
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
    + " configSchema=11",
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
  # farcaster-scan remains jitter-gated; list-scan cron retired in favour of KeepAlive x-scan
  cat >"$BIN_DIR/run-farcaster-scan" <<EOF
#!/bin/sh
exec "$BIN_DIR/run-job-jittered" farcaster-scan
EOF
  chmod 755 "$BIN_DIR/run-farcaster-scan"
  rm -f "$BIN_DIR/run-list-scan" 2>/dev/null || true
  echo "deployed runtime → $RUNTIME_ROOT"
  echo "wrapper → $TC"
  echo "jitter gate → $BIN_DIR/run-farcaster-scan"
  echo "lock retry → $BIN_DIR/run-with-lock-retry"
  echo "precheck → $BIN_DIR/run-precheck"
}

write_interval_plist() {
  label="$1"
  job="$2"
  seconds="$3"
  use_precheck="${4:-0}"
  run_at_load="${5:-0}"
  runner="$BIN_DIR/run-with-lock-retry"
  if [ "$use_precheck" -eq 1 ]; then
    runner="$BIN_DIR/run-precheck"
  fi
  out="$DEST/$label.plist"
  run_at_load_xml=""
  if [ "$run_at_load" -eq 1 ]; then
    run_at_load_xml=$(printf '  <key>RunAtLoad</key>\n  <true/>\n')
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
    <string>$WRAPPER_PREFIX; exec $runner $job</string>
  </array>
  <key>StartInterval</key>
  <integer>$seconds</integer>
$run_at_load_xml  <key>StandardOutPath</key>
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
    echo "would write $out ($job every ${seconds}s${use_precheck:+, precheck}${run_at_load:+, RunAtLoad})"
    return
  fi
  printf '%s\n' "$body" >"$out"
  echo "wrote $out"
}

# Social scans: launchd polls; ops/run-job-jittered.sh gates inter-run delay
# (farcaster-scan only — X list-scan is KeepAlive com.trenchcoat.x-scan)
write_jittered_job_plist() {
  job="$1"
  label="com.trenchcoat.job.$job"
  poll_seconds=900
  case "$job" in
    farcaster-scan) jitter_desc="3h15m–4h45m" ;;
    *) jitter_desc="jittered" ;;
  esac
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
    echo "would write $out ($job jittered $jitter_desc, poll ${poll_seconds}s)"
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

write_x_scan_plist() {
  out="$DEST/com.trenchcoat.x-scan.plist"
  body=$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.trenchcoat.x-scan</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>$WRAPPER_PREFIX; exec $TC listen x-scan</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>/tmp/trenchcoat.x-scan.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/trenchcoat.x-scan.err.log</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF
)
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would write $out (KeepAlive x-scan round-robin)"
    return
  fi
  printf '%s\n' "$body" >"$out"
  echo "wrote $out"
}

retire_list_scan_cron_plist() {
  label="com.trenchcoat.job.list-scan"
  out="$DEST/$label.plist"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would bootout and remove legacy $label (replaced by com.trenchcoat.x-scan KeepAlive)"
    return
  fi
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  if [ -f "$out" ]; then
    rm -f "$out"
    echo "removed legacy $out (x-scan is KeepAlive com.trenchcoat.x-scan)"
  fi
  # Stale jitter gate is harmless but confusing — clear on migrate
  rm -f "${TRENCHCOAT_HOME:-$HOME/.trenchcoat}/var/list-scan.next" 2>/dev/null || true
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

# Wait until no in-flight Cursor/host job before bootout/kickstart.
# Runs after the runtime swap so the active trenchcoat binary includes wait-idle.
wait_for_agent_idle() {
  if [ "$SKIP_AGENT_WAIT" -eq 1 ] || [ "$NO_LOAD" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then
    echo "skip agent-idle wait"
    return 0
  fi
  if [ ! -x "$TC" ]; then
    echo "warning: no trenchcoat binary to wait on agent idle — continuing" >&2
    return 0
  fi
  echo "waiting for in-flight agent/host work to finish before reload…"
  if ! "$TC" harness wait-idle --timeout-ms 1800000; then
    echo "refusing reload: in-flight agent work still running (or stale lock)." >&2
    echo "re-run when idle, or pass --skip-agent-wait (unsafe)." >&2
    exit 3
  fi
  echo "agent idle — proceeding with launchd reload"
}

# Pause cron/KeepAlive work for the duration of install. Jobs that fire while
# paused exit 3 / wait in run-with-lock-retry; deferred names are kickstarted
# after the pause clears.
begin_deploy_pause() {
  if [ "$DRY_RUN" -eq 1 ] || [ "$NO_LOAD" -eq 1 ]; then
    return 0
  fi
  mkdir -p "$HOME/.trenchcoat"
  chmod 700 "$HOME/.trenchcoat" 2>/dev/null || true
  now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  printf '%s\n' "{
  \"schema\": 1,
  \"pausedAt\": \"$now\",
  \"reason\": \"install-launchd\",
  \"deferredJobs\": []
}" > "$PAUSE_FILE"
  chmod 600 "$PAUSE_FILE"
  PAUSE_ACTIVE=1
  echo "deploy pause on → $PAUSE_FILE"
  # Stop StartInterval jobs from launching mid-upgrade; KeepAlives stay until
  # after wait-idle so in-flight work can finish cleanly.
  for label in \
    com.trenchcoat.job.chart-sweep \
    com.trenchcoat.job.watchlist-scan \
    com.trenchcoat.job.farcaster-scan \
    com.trenchcoat.job.narrative-scan \
    com.trenchcoat.job.research \
    com.trenchcoat.job.outcomes-settle \
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
    com.trenchcoat.job.discord-watchlist-scan \
    com.trenchcoat.job.harness-improve
  do
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  done
  echo "bootout scheduled jobs for deploy pause"
}

job_to_label() {
  case "$1" in
    chart-sweep) echo com.trenchcoat.job.chart-sweep ;;
    watchlist-scan) echo com.trenchcoat.job.watchlist-scan ;;
    list-scan) echo com.trenchcoat.x-scan ;;
    farcaster-scan) echo com.trenchcoat.job.farcaster-scan ;;
    narrative-scan) echo com.trenchcoat.job.narrative-scan ;;
    research) echo com.trenchcoat.job.research ;;
    outcomes-settle) echo com.trenchcoat.job.outcomes-settle ;;
    source-list-review) echo com.trenchcoat.job.source-list-review ;;
    fc-source-review) echo com.trenchcoat.job.fc-source-review ;;
    review) echo com.trenchcoat.job.review ;;
    audit) echo com.trenchcoat.job.audit ;;
    wallet-discovery) echo com.trenchcoat.job.wallet-discovery ;;
    wallet-scan-solana) echo com.trenchcoat.job.wallet-scan-solana ;;
    wallet-scan-evm) echo com.trenchcoat.job.wallet-scan-evm ;;
    wallet-review) echo com.trenchcoat.job.wallet-review ;;
    fomo-trader-sync) echo com.trenchcoat.job.fomo-trader-sync ;;
    fomo-signal-scan) echo com.trenchcoat.job.fomo-signal-scan ;;
    fomo-x-source-review) echo com.trenchcoat.job.fomo-x-source-review ;;
    fomo-narrative-source-scan) echo com.trenchcoat.job.fomo-narrative-source-scan ;;
    narrative-source-review) echo com.trenchcoat.job.narrative-source-review ;;
    delivery-retry) echo com.trenchcoat.job.delivery-retry ;;
    discord-watchlist-scan) echo com.trenchcoat.job.discord-watchlist-scan ;;
    telegram-alpha) echo com.trenchcoat.channels ;;
    harness-improve) echo com.trenchcoat.job.harness-improve ;;
    *) echo "" ;;
  esac
}

clear_deploy_pause_and_kick() {
  deferred_jobs=""
  if [ -f "$PAUSE_FILE" ] && [ -n "${NODE_BIN:-}" ]; then
    # Single-quoted node body — double quotes expand $j / $PAUSE_* under set -u
    deferred_jobs="$("$NODE_BIN" -e 'const fs=require("fs");try{const raw=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const jobs=Array.isArray(raw.deferredJobs)?raw.deferredJobs:[];process.stdout.write(jobs.filter((entry)=>typeof entry==="string").join(" "))}catch{process.stdout.write("")}' "$PAUSE_FILE")"
  fi
  rm -f "$PAUSE_FILE"
  PAUSE_ACTIVE=0
  echo "deploy pause cleared"
  if [ "$NO_LOAD" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then
    return 0
  fi
  for job in $deferred_jobs; do
    label="$(job_to_label "$job")"
    if [ -z "$label" ]; then
      echo "deferred job has no launchd label: $job" >&2
      continue
    fi
    echo "kickstarting deferred $job → $label"
    launchctl kickstart "$DOMAIN/$label" 2>/dev/null || true
  done
}

trap 'if [ "${PAUSE_ACTIVE:-0}" -eq 1 ]; then rm -f "${PAUSE_FILE:-}"; echo "deploy pause cleared (install aborted)" >&2; fi' EXIT

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

# --sync-env / --sync-skills alongside install: refresh before deploy/load
if [ "$SYNC_ENV" -eq 1 ]; then
  sync_env
fi
if [ "$SYNC_SKILLS" -eq 1 ]; then
  sync_skills
fi

upsert_repo_root_env

begin_deploy_pause
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
# list-scan cron retired — KeepAlive com.trenchcoat.x-scan round-robins FYP+lists
write_jittered_job_plist farcaster-scan
write_interval_plist com.trenchcoat.job.narrative-scan narrative-scan 21600
write_interval_plist com.trenchcoat.job.research research 3600 1
write_interval_plist com.trenchcoat.job.outcomes-settle outcomes-settle 21600 0 1
write_interval_plist com.trenchcoat.job.source-list-review source-list-review 86400 0 1
write_interval_plist com.trenchcoat.job.fc-source-review fc-source-review 86400 0 1
write_calendar_plist com.trenchcoat.job.review review 7 0
write_calendar_plist com.trenchcoat.job.audit audit 6 0 1
write_interval_plist com.trenchcoat.job.wallet-discovery wallet-discovery 21600 1
write_interval_plist com.trenchcoat.job.wallet-scan-solana wallet-scan-solana 300 1
write_interval_plist com.trenchcoat.job.wallet-scan-evm wallet-scan-evm 900 1
write_interval_plist com.trenchcoat.job.wallet-review wallet-review 86400
write_interval_plist com.trenchcoat.job.fomo-trader-sync fomo-trader-sync 21600 1
write_interval_plist com.trenchcoat.job.fomo-signal-scan fomo-signal-scan 1200 1
write_interval_plist com.trenchcoat.job.fomo-x-source-review fomo-x-source-review 21600 1
write_interval_plist com.trenchcoat.job.fomo-narrative-source-scan fomo-narrative-source-scan 21600 1
write_interval_plist com.trenchcoat.job.narrative-source-review narrative-source-review 86400 1
write_interval_plist com.trenchcoat.job.delivery-retry delivery-retry 900 1
write_discord_watchlist_scan_plist
# Always retire the old list-scan StartInterval job (even with --jobs-only)
retire_list_scan_cron_plist

if [ "$JOBS_ONLY" -eq 0 ]; then
  write_listener_plist
  write_channels_listener_plist
  write_x_scan_plist
  retire_discord_listener_plist
  write_router_plist
  write_backup_plist
fi

if [ "$WITH_HARNESS" -eq 1 ]; then
  write_interval_plist com.trenchcoat.job.harness-improve harness-improve 604800
fi

wait_for_agent_idle

# Load
for label in \
  com.trenchcoat.job.chart-sweep \
  com.trenchcoat.job.watchlist-scan \
  com.trenchcoat.job.farcaster-scan \
  com.trenchcoat.job.narrative-scan \
  com.trenchcoat.job.research \
  com.trenchcoat.job.outcomes-settle \
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
  bootstrap_label com.trenchcoat.x-scan
  bootstrap_label com.trenchcoat.router
  bootstrap_label com.trenchcoat.backup
fi

if [ "$WITH_HARNESS" -eq 1 ]; then
  bootstrap_label com.trenchcoat.job.harness-improve
fi

clear_deploy_pause_and_kick

echo "done. trenchcoat=$TC (runtime under $RUNTIME_ROOT)"
echo "logs: /tmp/trenchcoat.*.log"
echo "listener keepalive: launchctl print $DOMAIN/com.trenchcoat.listener (telegram + discord when enabled)"
echo "channels keepalive: launchctl print $DOMAIN/com.trenchcoat.channels"
echo "x-scan keepalive: launchctl print $DOMAIN/com.trenchcoat.x-scan"
echo "router keepalive: launchctl print $DOMAIN/com.trenchcoat.router"
echo "backup (manual smoke): $REPO_ROOT/ops/backup.sh"
echo "re-run this script after pulling code changes that affect the CLI"
