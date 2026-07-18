# Runbook

Deployment and operations for trenchcoat on macOS (launchd). Linux/cron
equivalents follow the same cadences.

## Layout on the host

```
~/.trenchcoat/
    ├── config.json            # operator config (docs/CONFIG.md)
    ├── env                    # mode 600, sourced by launchd plists (secrets)
    ├── pending-research.json  # Telegram research confirm queue (mode 600)
    ├── chat-session.json      # Cursor chat id for operator DMs
    ├── bin/trenchcoat         # launchd wrapper → runtime/ (outside Documents)
    ├── runtime/               # deployed dist + prod deps (ops/install-launchd.sh)
    ├── backups/               # weekly archive manifests (last-verified.json)
    ├── twitter-profile/       # Twitter burner auth (never in the repo)
    ├── farcaster/             # Neynar signer + custody (never in the repo)
    ├── telegram-session/      # GramJS session (never in the repo)
    ├── agent/                 # runtime workspace (git; weekly push if origin set)
    │   └── state/INDEX.md     # chat/job retrieval rollup (must exist; scaffold creates it)
    └── archive/               # host-side snapshot archive (docs/architecture/snapshot-archive.md)
```

## Scheduling

One plist per job from `ops/launchd/` (template: `com.trenchcoat.job.plist`),
plus keepalive plists for the GramJS listener and the broadcast router. Cadences
(initial — tune here, not in code):

| Job | Cadence |
|---|---|
| `chart-sweep` | hourly |
| `watchlist-scan` | every 2h |
| `list-scan` | ~every 4h (jittered 3h15m–4h45m; FYP + operator lists) |
| `farcaster-scan` | ~every 4h (jittered 3h15m–4h45m; requires `farcaster.enabled` + Neynar auth) |
| `source-list-review` | daily and after a sealed audit |
| `fc-source-review` | daily (Farcaster follow-graph sync) |
| `narrative-scan` | every 6h |
| `research` | scheduler dequeues from the research queue, cap in config |
| `review` | daily 07:00 — path-only sealed report + alpha manifests; skips when no reports, pending alpha, or watchlist scope |
| `audit` | weekly Mon 06:00 |
| `harness-improve` | weekly after audit (optional) — opens PR only; never merges |
| `router` (KeepAlive) | always — HMAC intake + Telegram/Discord fanout (`tc router serve`) |
| `listener` (KeepAlive) | always — operator Telegram DMs |

### Operator research (Telegram / CLI)

Ask the chat agent to research a token (or send `/research <subject>` /
`chain:address`). The host proposes a confirmation; reply `confirm` to enqueue
and run under the workspace lock, or `cancel` to drop it. Progress and the
report path are DMed on the operator bot. Equivalent CLI:
`tc research solana:<mint>` (optional `--skip-agent` / `--dry-collect`).

Optional web search needs `TAVILY_API_KEY` in `~/.trenchcoat/env` (free tier is
enough at current caps). Agents never receive the key and cannot fetch arbitrary
URLs. Confirmed research also runs a bounded X token search via the burner
profile (`pnpm dev:cli auth twitter` if challenged) and writes
sentiment/popularity snapshots for the report.

Harness improvement requires `harness_improvement.enabled` **and**
`schedule_enabled` in config. The job proposes from sealed epochs, builds on a
fresh branch, runs tests, and opens a PR for manual approval
(docs/architecture/harness-improvement.md). Canary remains a separate explicit
step after merge.

Install (preferred):

```bash
# requires ~/.trenchcoat/env (mode 600); deploys CLI to ~/.trenchcoat/runtime
# (launchd cannot read ~/Documents — TCC)
./ops/install-launchd.sh
```

This wipes repo `dist/` then builds and copies a runtime under
`~/.trenchcoat/runtime`, wraps it as `~/.trenchcoat/bin/trenchcoat`, deploys
jittered social-scan gates to `~/.trenchcoat/bin/run-list-scan` and
`run-farcaster-scan`, deploys `run-with-lock-retry` (up to 3 attempts on exit 3
lock contention, 30–180s jitter), materializes one plist per job into
`~/Library/LaunchAgents/` (each job invokes lock-retry), loads the Telegram
listener and broadcast router with `KeepAlive: true` (recovery tier 1,
docs/architecture/orchestrator.md / router.md), schedules the weekly backup
(`com.trenchcoat.backup`, Sun 05:00 → `ops/backup.sh`), writes
`runtime/deployment.json` after staging + `config validate`, and bootstraps job
cadences below. Re-run after CLI changes. Flags: `--dry-run`, `--no-load`,
`--with-harness`, `--jobs-only`, `--sync-env`. The wipe matters: plain `tsc`
leaves deleted modules in `dist/`, which would otherwise ship into the runtime.

`--sync-env` atomically copies repo `.env` → `~/.trenchcoat/env` (mode 600) after
validating required key **names** (values never read); used alone it syncs and
exits without redeploying, otherwise it refreshes env before deploy. This is how
`TAVILY_API_KEY` and the router/destination secrets reach launchd jobs (which
cannot read `~/Documents` under TCC).

Staging safety: the installer builds into a staging dir, validates config with
the staged binary, then atomically swaps `runtime/` (previous kept as
`runtime.previous`). A missing `deployment.json` is flagged by `tc status`.

For harness improvement only: `./ops/install-launchd.sh --with-harness`
(requires `harness_improvement.enabled` + `schedule_enabled`, `gh` auth).

## Health checks

- `tc status` — last run per job, queue depth, lock state. A job whose last
  completed run is older than 3x its cadence is unhealthy.
- Router health: `curl -sS http://127.0.0.1:8787/healthz` must return
  `{"ok":true}`. Without `com.trenchcoat.router`, staged broadcasts never fan
  out. Logs: `/tmp/trenchcoat.router.*.log`. Kick after env/runtime changes:
  `launchctl kickstart -k gui/$(id -u)/com.trenchcoat.router`. Telegram fanout
  needs both `TELEGRAM_ROUTER_BOT_TOKEN` and `TELEGRAM_ROUTER_CHAT_ID` in
  `~/.trenchcoat/env` (Discord needs `DISCORD_WEBHOOK_URL`). If err logs show
  missing `better_sqlite3.node`, re-run `./ops/install-launchd.sh` (installer
  rebuilds the native addon after prod install).
- Listener health: the listener touches a heartbeat file every poll cycle;
  `tc status` flags a stale heartbeat (> 15 min). launchd restarts crashes;
  a silently wedged process is caught by the heartbeat and killed by
  the next `tc status --heal` (safe: alpha-queue appends are atomic per
  message, INV-Q1).
- Operator Telegram chat: `com.trenchcoat.listener` runs `tc listen telegram`,
  which bridges private DMs to a resumable Cursor `--mode ask` session over
  `~/.trenchcoat/agent` and streams tokens via `sendMessageDraft` before the
  final `sendMessage` (docs/architecture/chat-agent.md). Research asks are
  confirmation-gated on the host; confirmed work runs asynchronously under the
  workspace lock. After CLI / chat / research code changes, re-run
  `./ops/install-launchd.sh` (deploys `~/.trenchcoat/runtime`) and kick the
  listener: `launchctl kickstart -k gui/$(id -u)/com.trenchcoat.listener`.
  `install-launchd.sh` does **not** sync `agent/skills/` — copy changed skills
  from the repo into `~/.trenchcoat/agent/skills/` or the ask-mode chat agent
  will keep old deferral text. Stale runtime is the usual cause of research
  asks falling through to a long ask-mode lecture instead of
  `Research <subject>? Reply confirm or cancel.` Session id lives in
  `~/.trenchcoat/chat-session.json`.
- Knowledge rollup: `~/.trenchcoat/agent/state/INDEX.md` must exist (empty
  skeleton is fine). Chat and scan skills read it first; older homes that
  predate `scripts/scaffold-agent.ts` creating the file need a one-time copy
  from repo `agent/state/INDEX.md` (docs/architecture/agent-workspace.md).

## Operator procedures

- **Twitter re-auth** — on a "needs headful re-auth" DM: `tc auth twitter`,
  complete the login interactively. Never scripted (documented exception,
  docs/INVARIANTS.md).
- **Managed source list setup** — after configuring both immutable operator
  list URLs, run `tc auth twitter --create-managed-list`. Confirm the resulting
  private-list ID in `tc probe twitter`. Normal jobs never create another list.
- **Source-list dry run** — `tc source-list review --dry-run` prints deterministic
  transitions without mutating state or X. `tc source-list sync` applies only
  already-committed pending transitions to the persisted managed-list ID.
- **FYP engagement** — the bot writes `reports/<run-id>/x-engagement.json`.
  Likes are hard-capped at 2 every 10 minutes; like/follow/unfollow targets must
  appear in the same-run FYP snapshot (INV-S22). Dry-run with
  `tc x-engagement dry-run <run-id>`.
- **Exoneration review** — on a `warn` DM: reply `undock <id>` or
  `confirm <id>` in Telegram (or `tc undock` / `tc confirm`). No timeout — the
  penalty stays suspended and the adjacency counter already incremented.
- **Outcome settlement** — `tc run outcomes-settle` materializes mature
  source-call and wallet-buy observations (also invoked before `tc run audit`).
  Missing prices stay pending/excluded and never become invented losses.
- **Narrative broadcasts** — `tc run narrative-scan` (every ~6h). Agent maintains
  `agent/state/narratives/log.jsonl` and proposes outbox items only for new
  slugs; host prunes entries older than `narratives.retention_days` (schema 7,
  default 14). If `~/.trenchcoat/config.json` is still schema 6 on disk,
  `loadConfig` migrates in memory — re-save or copy from repo `config.json` to
  persist `narratives` on disk.
- **Adding a Telegram channel** — add to `config.json` with `mode: "preview"`;
  if the first poll flags previews-disabled, switch to `"gramjs"` and restart
  the listener.
- **Removing a watchlist entry** — for ignored/revisit/dropped subjects (e.g.
  after research rejected `$REPPO`):  
  `tc watchlist remove <chain:token> --subject <SYMBOL> --reason <text>`.  
  Host-only; refuses `tracking`/`watching` and open ledger positions; reconciles
  `state/INDEX.md`.
- **Farcaster enablement** — operator sequence (after `farcaster.enabled` + `NEYNAR_API_KEY`
  in env):
  1. `tc auth farcaster --fid <n> --username <name> --mnemonic-stdin` (or `--create`)
  2. Approve signer in Farcaster mobile app, or fund custody on Optimism and re-run auth
  3. `tc fc-source seed config/fc-source-seed.json --dry-run` then apply without `--dry-run`
  4. `tc fc-source sync --dry-run` then apply without `--dry-run`
  5. `tc probe farcaster` — confirm `signerStatus=approved`, live for-you casts, managed count
  Collection and engagement jobs gate mutations on approved signer; pending states write
  explicit receipts only. For-you feeds with no live casts, the repeated-two-hash
  stale pattern, or **future-dated timestamps** (e.g. 2061/2076 clock noise) are
  rejected with `skipAgent=true` — they never reach the agent or the FYP like
  allowlist.
- **Seeding wallets** — optional. Copy `config/operator-seed.example.json`, fill
  `wallets[]` (`solana` / `ethereum` / `base` / `robinhood`), then
  `pnpm dev:cli wallets seed path/to/operator-seed.json`. Refuses if
  `agent/state/wallets.json` already has entries. Autonomous discovery can
  populate an empty file via `tc run wallet-discovery`. Wallet scans require a
  seeded or discovered eligible wallet.
- **Wallet jobs** — `wallet-discovery` (6h), `wallet-scan-solana`
  (5m), and `wallet-scan-evm` (15m) run deterministic host collection plus an
  evidence-only wallet agent over frozen snapshots. `wallet-review` (daily)
  remains host-only. Need `HELIUS_API_KEY`
  and/or `INFURA_API_KEY` in the env file; Robinhood uses the throttled public
  RPC (no key). Cursors live in `state/wallets.json`; crash-safe resume is
  automatic on the next run. Empty prerequisites skip cleanly:
  discovery needs active watchlist subjects on wallet-supported chains;
  scans need non-empty wallets with eligible status for the family;
  chart-sweep / watchlist-scan need active watchlist subjects. Empty jobs
  emit one line to `archive/skips/<job>.jsonl` without creating a run dir,
  inbox, or agent report (`tc precheck <job>` for a lock-free probe). The
  agent cannot nominate, score, add, drop, or mutate wallets
  (`skippedReason` values in smart-wallets.md).
- **Adding a chain** — flow in docs/architecture/chains.md.
- **Failed-run triage** — tier 1 recovery is automatic. If DMed about a
  recovery-agent run, read `agent/reports/` diagnosis; state is already
  rolled back or repaired. Escalate to manual only on repeated same-job
  failures (the DM says so).

## Backups and retention

`~/.trenchcoat/agent` is a git repo — state history is the backup (INV-S8).
Weekly launchd `com.trenchcoat.backup` runs `ops/backup.sh`: commit (and
`git push` when `origin` exists), then `tc backup` which writes a gzip
manifest + sampled content hashes under `~/.trenchcoat/backups/` (override
with `TRENCHCOAT_BACKUP_DIR`) and records `last-verified.json`. Add a private
`origin` on the agent repo for off-box recovery. Archive garbage collection
refuses to run when no verified backup exists. Smoke: `./ops/backup.sh`.

Retention sweeps (workspace/failed inboxes 30d, host run folders 90d, chat
reports 30d) run inside `review`; hash-referenced decision/outcome/epoch/source
records remain. `state/` and `decisions.md` are never pruned.
