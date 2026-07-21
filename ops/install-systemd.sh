#!/bin/sh
# Linux counterpart to ops/install-launchd.sh — user systemd units + timers.
# Cadences match ops/runbook.md. Requires: loginctl enable-linger $USER
# Usage: ops/install-systemd.sh [--dry-run] [--without-harness] [--jobs-only]
#                               [--no-load] [--sync-env] [--sync-skills] [--allow-dirty]
#                               [--skip-agent-wait]
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
HOME="${HOME:-$(cd ~ && pwd)}"
DEST="$HOME/.config/systemd/user"
ENV_FILE="$HOME/.trenchcoat/env"
AGENT_ROOT="$HOME/.trenchcoat/agent"
DISCORD_AGENT_ROOT="$HOME/.trenchcoat/discord/agent"
RUNTIME_ROOT="$HOME/.trenchcoat/runtime"
RUNTIME_STAGING="$HOME/.trenchcoat/runtime.next"
RUNTIME_PREVIOUS="$HOME/.trenchcoat/runtime.prev"
BIN_DIR="$HOME/.trenchcoat/bin"
TC="$BIN_DIR/trenchcoat"
PAUSE_FILE="$HOME/.trenchcoat/deploy-pause.json"
DEPLOY_LINK="$HOME/bin/trenchcoat-deploy"
DRY_RUN=0
WITH_HARNESS=1
JOBS_ONLY=0
NO_LOAD=0
SYNC_ENV=0
SYNC_SKILLS=0
ALLOW_DIRTY=0
SKIP_AGENT_WAIT=0
PAUSE_ACTIVE=0
INSTALL_ARGS=0

REQUIRED_ENV_KEYS="TRENCHCOAT_ROUTER_URL TRENCHCOAT_ROUTER_TOKEN TRENCHCOAT_ROUTER_HMAC_KEY TELEGRAM_BOT_TOKEN TELEGRAM_OPERATOR_ID HELIUS_API_KEY INFURA_API_KEY NEYNAR_API_KEY GOPLUS_APP_KEY COINGECKO_DEMO_KEY"

if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  XDG_RUNTIME_DIR="/run/user/$(id -u)"
  export XDG_RUNTIME_DIR
fi

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
    printf '\n# Git checkout for harness-improve / deploy\nTRENCHCOAT_REPO_ROOT=%s\n' "$REPO_ROOT" >>"$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  echo "TRENCHCOAT_REPO_ROOT → $REPO_ROOT"
}

sync_one_agent_skills() {
  dest_root="$1"
  label="$2"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would sync skills + AGENTS.md → $dest_root ($label)"
    return
  fi
  mkdir -p "$dest_root/skills"
  rsync -a --delete "$REPO_ROOT/agent/skills/" "$dest_root/skills/"
  cp "$REPO_ROOT/agent/AGENTS.md" "$dest_root/AGENTS.md"
  echo "synced skills + AGENTS.md → $dest_root ($label)"
}

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
  sync_one_agent_skills "$AGENT_ROOT" "main"
  if [ -d "$DISCORD_AGENT_ROOT" ] || [ -d "$HOME/.trenchcoat/discord" ]; then
    sync_one_agent_skills "$DISCORD_AGENT_ROOT" "discord"
  fi
}

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

export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node not on PATH" >&2
  exit 1
fi

# Shell fragment sourced before every job (HOME expanded at unit write time)
env_prefix() {
  printf 'set -a; [ -f "%s/.trenchcoat/env" ] && . "%s/.trenchcoat/env"; set +a' "$HOME" "$HOME"
}

deploy_runtime() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would deploy runtime → $RUNTIME_ROOT (via $RUNTIME_STAGING) and wrapper → $TC"
    return
  fi
  (
    cd "$REPO_ROOT"
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
  # lockfile + allowBuilds so prod install/rebuild can compile better-sqlite3
  cp "$REPO_ROOT/pnpm-lock.yaml" "$RUNTIME_STAGING/pnpm-lock.yaml"
  cp "$REPO_ROOT/pnpm-workspace.yaml" "$RUNTIME_STAGING/pnpm-workspace.yaml"
  (
    cd "$RUNTIME_STAGING"
    # ignore-scripts skips lifecycle hooks for speed/safety, but better-sqlite3
    # (router SQLite) needs its native addon — rebuild that one explicitly
    pnpm install --prod --ignore-scripts --config.confirmModulesPurge=false >/dev/null
    if ! pnpm rebuild better-sqlite3; then
      echo "pnpm rebuild better-sqlite3 failed — router will not start" >&2
      exit 1
    fi
    if ! find node_modules -name better_sqlite3.node -type f | grep -q .; then
      echo "better_sqlite3.node missing after rebuild — refusing to deploy" >&2
      exit 1
    fi
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
  SOURCE_DIFF="$(git -C "$REPO_ROOT" diff HEAD 2>/dev/null || true)"
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
  configSchema: 14,
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
    + " configSchema=14",
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
  cp "$REPO_ROOT/ops/trenchcoat-deploy.sh" "$BIN_DIR/trenchcoat-deploy"
  chmod 755 "$BIN_DIR/run-job-jittered" "$BIN_DIR/run-with-lock-retry" "$BIN_DIR/run-precheck" "$BIN_DIR/trenchcoat-deploy"
  cat >"$BIN_DIR/run-farcaster-scan" <<EOF
#!/bin/sh
exec "$BIN_DIR/run-job-jittered" farcaster-scan
EOF
  chmod 755 "$BIN_DIR/run-farcaster-scan"
  rm -f "$BIN_DIR/run-list-scan" 2>/dev/null || true

  mkdir -p "$HOME/bin"
  ln -sfn "$BIN_DIR/trenchcoat-deploy" "$DEPLOY_LINK"
  echo "deployed runtime → $RUNTIME_ROOT"
  echo "wrapper → $TC"
  echo "deploy entrypoint → $DEPLOY_LINK → $BIN_DIR/trenchcoat-deploy"
}

# --- unit writers ---

write_oneshot_service() {
  unit="$1"
  job_log="$2"
  cmd="$3"
  out="$DEST/$unit.service"
  body=$(cat <<EOF
[Unit]
Description=trenchcoat $unit
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$HOME
Environment=HOME=$HOME
Environment=PATH=$HOME/.local/bin:$BIN_DIR:/usr/local/bin:/usr/bin
ExecStart=/bin/sh -c '$(env_prefix); exec $cmd'
StandardOutput=append:/tmp/trenchcoat.$job_log.out.log
StandardError=append:/tmp/trenchcoat.$job_log.err.log

[Install]
WantedBy=default.target
EOF
)
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would write $out"
    return
  fi
  printf '%s\n' "$body" >"$out"
  echo "wrote $out"
}

write_interval_timer() {
  unit="$1"
  seconds="$2"
  run_at_load="${3:-0}"
  out="$DEST/$unit.timer"
  on_boot=""
  if [ "$run_at_load" -eq 1 ]; then
    on_boot="OnBootSec=1min"
  else
    on_boot="OnBootSec=3min"
  fi
  body=$(cat <<EOF
[Unit]
Description=trenchcoat timer $unit

[Timer]
$on_boot
OnUnitActiveSec=${seconds}s
AccuracySec=30s
Persistent=true
Unit=$unit.service

[Install]
WantedBy=timers.target
EOF
)
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would write $out (every ${seconds}s)"
    return
  fi
  printf '%s\n' "$body" >"$out"
  echo "wrote $out"
}

write_calendar_timer() {
  unit="$1"
  # OnCalendar expression e.g. *-*-* 07:00:00 or Mon *-*-* 06:00:00
  calendar="$2"
  out="$DEST/$unit.timer"
  body=$(cat <<EOF
[Unit]
Description=trenchcoat calendar $unit

[Timer]
OnCalendar=$calendar
Persistent=true
Unit=$unit.service

[Install]
WantedBy=timers.target
EOF
)
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would write $out ($calendar)"
    return
  fi
  printf '%s\n' "$body" >"$out"
  echo "wrote $out"
}

write_interval_job() {
  job="$1"
  seconds="$2"
  use_precheck="${3:-0}"
  run_at_load="${4:-0}"
  unit="trenchcoat-job-$job"
  runner="$BIN_DIR/run-with-lock-retry"
  if [ "$use_precheck" -eq 1 ]; then
    runner="$BIN_DIR/run-precheck"
  fi
  write_oneshot_service "$unit" "$job" "$runner $job"
  write_interval_timer "$unit" "$seconds" "$run_at_load"
}

write_jittered_job() {
  job="$1"
  unit="trenchcoat-job-$job"
  write_oneshot_service "$unit" "$job" "$BIN_DIR/run-$job"
  # launchd polls every 900s; jitter script no-ops until due
  write_interval_timer "$unit" 900 0
}

write_keepalive_service() {
  unit="$1"
  job_log="$2"
  cmd="$3"
  out="$DEST/$unit.service"
  body=$(cat <<EOF
[Unit]
Description=trenchcoat keepalive $unit
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$HOME
Environment=HOME=$HOME
Environment=PATH=$HOME/.local/bin:$BIN_DIR:/usr/local/bin:/usr/bin
ExecStart=/bin/sh -c '$(env_prefix); exec $cmd'
Restart=always
RestartSec=30
StandardOutput=append:/tmp/trenchcoat.$job_log.out.log
StandardError=append:/tmp/trenchcoat.$job_log.err.log

[Install]
WantedBy=default.target
EOF
)
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would write $out (Restart=always)"
    return
  fi
  printf '%s\n' "$body" >"$out"
  echo "wrote $out"
}

write_discord_watchlist() {
  unit="trenchcoat-job-discord-watchlist-scan"
  write_oneshot_service "$unit" "discord-watchlist-scan" "$TC discord watchlist scan"
  out="$DEST/$unit.timer"
  body=$(cat <<EOF
[Unit]
Description=trenchcoat discord watchlist scan

[Timer]
OnCalendar=*-*-* 00,06,12,18:00:00
Persistent=true
Unit=$unit.service

[Install]
WantedBy=timers.target
EOF
)
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would write $out (0/6/12/18)"
    return
  fi
  printf '%s\n' "$body" >"$out"
  echo "wrote $out"
}

write_discord_chain() {
  # On-demand only — no timer; kick via systemctl or detached CLI fallback
  write_oneshot_service "trenchcoat-job-discord-chain-integration" "discord-chain-integration" "$TC discord chains run"
}

write_backup() {
  unit="trenchcoat-backup"
  write_oneshot_service "$unit" "backup" "$REPO_ROOT/ops/backup.sh"
  write_calendar_timer "$unit" "Sun *-*-* 05:00:00"
}

job_to_unit() {
  case "$1" in
    chart-sweep) echo trenchcoat-job-chart-sweep ;;
    watchlist-scan) echo trenchcoat-job-watchlist-scan ;;
    list-scan) echo trenchcoat-x-scan ;;
    farcaster-scan) echo trenchcoat-job-farcaster-scan ;;
    narrative-scan) echo trenchcoat-job-narrative-scan ;;
    research) echo trenchcoat-job-research ;;
    outcomes-settle) echo trenchcoat-job-outcomes-settle ;;
    source-list-review) echo trenchcoat-job-source-list-review ;;
    fc-source-review) echo trenchcoat-job-fc-source-review ;;
    review) echo trenchcoat-job-review ;;
    audit) echo trenchcoat-job-audit ;;
    wallet-discovery) echo trenchcoat-job-wallet-discovery ;;
    wallet-runner-discovery) echo trenchcoat-job-wallet-runner-discovery ;;
    wallet-scan-solana) echo trenchcoat-job-wallet-scan-solana ;;
    wallet-scan-evm) echo trenchcoat-job-wallet-scan-evm ;;
    wallet-review) echo trenchcoat-job-wallet-review ;;
    fomo-trader-sync) echo trenchcoat-job-fomo-trader-sync ;;
    fomo-signal-scan) echo trenchcoat-job-fomo-signal-scan ;;
    fomo-x-source-review) echo trenchcoat-job-fomo-x-source-review ;;
    fomo-narrative-source-scan) echo trenchcoat-job-fomo-narrative-source-scan ;;
    narrative-source-review) echo trenchcoat-job-narrative-source-review ;;
    delivery-retry) echo trenchcoat-job-delivery-retry ;;
    discord-watchlist-scan) echo trenchcoat-job-discord-watchlist-scan ;;
    discord-chain-integration) echo trenchcoat-job-discord-chain-integration ;;
    telegram-alpha) echo trenchcoat-channels ;;
    harness-improve) echo trenchcoat-job-harness-improve ;;
    incident-remediate) echo trenchcoat-job-incident-remediate ;;
    incident-remediate-weekly) echo trenchcoat-job-incident-remediate-weekly ;;
    *) echo "" ;;
  esac
}

SCHEDULED_UNITS="
trenchcoat-job-chart-sweep
trenchcoat-job-watchlist-scan
trenchcoat-job-farcaster-scan
trenchcoat-job-narrative-scan
trenchcoat-job-research
trenchcoat-job-outcomes-settle
trenchcoat-job-source-list-review
trenchcoat-job-fc-source-review
trenchcoat-job-review
trenchcoat-job-audit
trenchcoat-job-wallet-discovery
trenchcoat-job-wallet-runner-discovery
trenchcoat-job-wallet-scan-solana
trenchcoat-job-wallet-scan-evm
trenchcoat-job-wallet-review
trenchcoat-job-fomo-trader-sync
trenchcoat-job-fomo-signal-scan
trenchcoat-job-fomo-x-source-review
trenchcoat-job-fomo-narrative-source-scan
trenchcoat-job-narrative-source-review
trenchcoat-job-delivery-retry
trenchcoat-job-discord-watchlist-scan
trenchcoat-job-incident-remediate
trenchcoat-job-incident-remediate-weekly
"

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
  \"reason\": \"install-systemd\",
  \"deferredJobs\": []
}" > "$PAUSE_FILE"
  chmod 600 "$PAUSE_FILE"
  PAUSE_ACTIVE=1
  echo "deploy pause on → $PAUSE_FILE"
  for unit in $SCHEDULED_UNITS trenchcoat-job-harness-improve trenchcoat-backup; do
    systemctl --user stop "$unit.timer" 2>/dev/null || true
  done
  echo "stopped scheduled timers for deploy pause"
}

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
  echo "agent idle — proceeding with systemd reload"
}

clear_deploy_pause_and_kick() {
  deferred_jobs=""
  if [ -f "$PAUSE_FILE" ] && [ -n "${NODE_BIN:-}" ]; then
    deferred_jobs="$("$NODE_BIN" -e 'const fs=require("fs");try{const raw=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const jobs=Array.isArray(raw.deferredJobs)?raw.deferredJobs:[];process.stdout.write(jobs.filter((entry)=>typeof entry==="string").join(" "))}catch{process.stdout.write("")}' "$PAUSE_FILE")"
  fi
  rm -f "$PAUSE_FILE"
  PAUSE_ACTIVE=0
  echo "deploy pause cleared"
  if [ "$NO_LOAD" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then
    return 0
  fi
  for job in $deferred_jobs; do
    unit="$(job_to_unit "$job")"
    if [ -z "$unit" ]; then
      echo "deferred job has no systemd unit: $job" >&2
      continue
    fi
    echo "starting deferred $job → $unit.service"
    systemctl --user start "$unit.service" 2>/dev/null || true
  done
}

trap 'if [ "${PAUSE_ACTIVE:-0}" -eq 1 ]; then rm -f "${PAUSE_FILE:-}"; echo "deploy pause cleared (install aborted)" >&2; fi' EXIT

enable_unit() {
  unit="$1"
  kind="$2"
  if [ "$NO_LOAD" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then
    echo "skip load $unit.$kind"
    return
  fi
  systemctl --user daemon-reload
  systemctl --user enable "$unit.$kind"
  if [ "$kind" = "timer" ]; then
    systemctl --user restart "$unit.timer"
  else
    systemctl --user restart "$unit.service"
  fi
  echo "loaded $unit.$kind"
}

# --- host prep ---
if [ "$DRY_RUN" -eq 0 ]; then
  mkdir -p "$DEST" "$HOME/.trenchcoat/backups" "$HOME/bin"
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
      echo "missing $ENV_FILE — create it (mode 600) or rsync from desktop before install" >&2
      exit 1
    fi
  fi
  if [ ! -f "$HOME/.trenchcoat/config.json" ]; then
    echo "missing $HOME/.trenchcoat/config.json — rsync host state from desktop before first install" >&2
    exit 1
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
  chmod +x "$REPO_ROOT/ops/backup.sh" "$REPO_ROOT/ops/install-systemd.sh" "$REPO_ROOT/ops/trenchcoat-deploy.sh"
fi

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

# Cadences from ops/runbook.md (same as install-launchd.sh)
write_interval_job chart-sweep 3600 1
write_interval_job watchlist-scan 7200 1
write_jittered_job farcaster-scan
write_interval_job narrative-scan 21600
write_interval_job research 3600 1
write_interval_job outcomes-settle 21600 0 1
write_interval_job source-list-review 86400 0 1
write_interval_job fc-source-review 86400 0 1
write_oneshot_service trenchcoat-job-review review "$BIN_DIR/run-precheck review"
write_calendar_timer trenchcoat-job-review "*-*-* 07:00:00"
write_oneshot_service trenchcoat-job-audit audit "$BIN_DIR/run-precheck audit"
write_calendar_timer trenchcoat-job-audit "Mon *-*-* 06:00:00"
write_interval_job wallet-discovery 21600 1
write_interval_job wallet-runner-discovery 1800 1
write_interval_job wallet-scan-solana 300 1
write_interval_job wallet-scan-evm 900 1
write_interval_job wallet-review 86400
write_interval_job fomo-trader-sync 21600 1
write_interval_job fomo-signal-scan 1200 1
write_interval_job fomo-x-source-review 21600 1
write_interval_job fomo-narrative-source-scan 21600 1
write_interval_job narrative-source-review 86400 1
write_interval_job delivery-retry 900 1
write_discord_watchlist
write_discord_chain
write_interval_job incident-remediate 3600
write_oneshot_service trenchcoat-job-incident-remediate-weekly incident-remediate-weekly "$BIN_DIR/run-precheck incident-remediate-weekly"
write_calendar_timer trenchcoat-job-incident-remediate-weekly "Mon *-*-* 08:00:00"

if [ "$JOBS_ONLY" -eq 0 ]; then
  write_keepalive_service trenchcoat-listener listener "$TC listen"
  write_keepalive_service trenchcoat-channels channels "$TC listen channels"
  write_keepalive_service trenchcoat-x-scan x-scan "$TC listen x-scan"
  write_keepalive_service trenchcoat-router router "$TC router serve"
  write_backup
fi

if [ "$WITH_HARNESS" -eq 1 ]; then
  write_interval_job harness-improve 604800
fi

wait_for_agent_idle

if [ "$NO_LOAD" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  if ! systemctl --user status >/dev/null 2>&1; then
    echo "systemctl --user unavailable. Run once as root: loginctl enable-linger $(whoami)" >&2
    echo "Then re-login (or export XDG_RUNTIME_DIR=/run/user/\$(id -u)) and re-run." >&2
    exit 1
  fi
fi

for unit in $SCHEDULED_UNITS; do
  enable_unit "$unit" timer
done
# on-demand chain unit — enable service only (no timer)
if [ "$NO_LOAD" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  systemctl --user daemon-reload
  systemctl --user enable trenchcoat-job-discord-chain-integration.service
fi

if [ "$JOBS_ONLY" -eq 0 ]; then
  enable_unit trenchcoat-listener service
  enable_unit trenchcoat-channels service
  enable_unit trenchcoat-x-scan service
  enable_unit trenchcoat-router service
  enable_unit trenchcoat-backup timer
fi

if [ "$WITH_HARNESS" -eq 1 ]; then
  enable_unit trenchcoat-job-harness-improve timer
fi

clear_deploy_pause_and_kick

echo "done. trenchcoat=$TC (runtime under $RUNTIME_ROOT)"
echo "deploy: $DEPLOY_LINK"
echo "logs: /tmp/trenchcoat.*.log"
echo "status: systemctl --user list-timers 'trenchcoat-*'"
echo "keepalive: systemctl --user status trenchcoat-router trenchcoat-listener trenchcoat-channels trenchcoat-x-scan"
echo "re-run after pulling CLI changes, or use ~/bin/trenchcoat-deploy"
