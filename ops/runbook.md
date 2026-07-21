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
| `x-scan` (KeepAlive) | always — round-robin FYP → lists with cursor stop; random 5–30m between rounds (`tc listen x-scan`) |
| `farcaster-scan` | ~every 4h (jittered 3h15m–4h45m; requires `farcaster.enabled` + Neynar auth) |
| `source-list-review` | daily (`RunAtLoad`) and after a sealed audit; writes lagged `sources.json` scores |
| `fc-source-review` | daily (`RunAtLoad`; Farcaster follow-graph sync + lagged scores) |
| `outcomes-settle` | every 6h (`RunAtLoad`) and before audit |
| `narrative-scan` | every 6h |
| `research` | Immediate drain when social/narrative/fomo enqueue; hourly cron remains as backstop |
| `fomo-trader-sync` | every 6h (host-only; skips unless `fomo.enabled` + gates) |
| `fomo-signal-scan` | every 20m (host-only; skips unless `fomo.enabled` + gates) |
| `fomo-x-source-review` | every 6h (one nomination; requires `fomo.x_source_review.enabled`) |
| `fomo-narrative-source-scan` | every 6h (probation live posts; `narrative_source_probation`) |
| `narrative-source-review` | daily (promote/demote + gated follow) |
| `delivery-retry` | every 15m (host-only; retries staged router ingress without a terminal receipt; skips when router env missing or backlog empty) |

Fomo gates: `pnpm fomo:install-gates` (default seed fails closed). Shadow playbook:
[ops/fafo-fomo/SHADOW-CANARY.md](fafo-fomo/SHADOW-CANARY.md). Auth: `pnpm dev:cli auth fomo`.
| `review` | daily 07:00 — path-only sealed report + alpha manifests; skips when no reports, pending alpha, or watchlist scope |
| `audit` | weekly Mon 06:00 |
| `harness-improve` | weekly after audit (default on; `--without-harness` to opt out) — plan/review/build, local main ff, runtime deploy; never activates agent or starts canary |
| `incident-remediate` | hourly (default **off** until `incident_remediation.enabled` + `schedule_enabled`) — scan health/logs, triage, gated fix/publish |
| `incident-remediate-weekly` | Monday 08:00 local (default **off**) — one deferred remediation; never feeds the policy harness |
| `router` (KeepAlive) | always — HMAC intake + Telegram/Discord fanout (`tc router serve`) |
| `listener` (KeepAlive) | always — operator Telegram DMs + Discord research when `chat.discord.enabled` (`tc listen`) |
| `channels` (KeepAlive) | always — alpha-channel preview poller (~60s cycle) + immediate `telegram-alpha` agent per new message (`tc listen channels`) |

### Tuning social scan cadence

Cadence lives in code/ops scripts, not `config.json`:

| Surface | Where to edit | Apply |
|---|---|---|
| X `x-scan` | `src/orchestrator/x-scan-cursors.ts` delay bounds (5–30m); cursors in `~/.trenchcoat/x-scan/cursors.json` | Redeploy + `launchctl kickstart -k gui/$(id -u)/com.trenchcoat.x-scan` |
| Farcaster `farcaster-scan` | `ops/run-job-jittered.sh` — `farcaster-scan` branch (3h15m–4h45m) | Same; `~/.trenchcoat/var/farcaster-scan.next` |
| TG alpha preview | `src/collectors/telegram/channels.ts` — default `pollIntervalMs` (60s) | Redeploy runtime + `launchctl kickstart -k gui/$(id -u)/com.trenchcoat.channels` (not listener) |

Launchd polls jittered farcaster every 15m; `run-job-jittered.sh` no-ops until
`~/.trenchcoat/var/farcaster-scan.next` (written after each **successful** run). Changing
the script does not retroactively shorten an existing `.next` backoff — delete
that file when you need the new range immediately.

`list-scan` cron was retired — one-shot `tc run list-scan` still works for a
full multi-target scrape. Streaming X uses KeepAlive `com.trenchcoat.x-scan`.

Verify after deploy: channels startup log must show intended `pollMs` (e.g.
`60000` = 60s); x-scan log shows target labels and round delays; farcaster
`~/.trenchcoat/bin/run-job-jittered` contains `MIN_SEC`/`MAX_SEC`.

If `install-launchd.sh` exits non-zero mid-keepalive bootstrap (`Bootstrap
failed: 5` on `com.trenchcoat.listener` is common when already running), later
units (`com.trenchcoat.channels`, `com.trenchcoat.x-scan`, router) may never load — confirm with
`launchctl print gui/$(id -u)/com.trenchcoat.channels` and bootstrap +
`kickstart -k` if missing (same recovery as Discord listener notes below).

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
`schedule_enabled` in config (defaults true for new schema 11 installs; explicit
`false` is preserved on migrate). The job proposes from sealed epochs with
decision-time signals, requires independent plan review before build, grades
with holdout replay + protected metrics, requires implementation review, then
fast-forwards local `main` and deploys host runtime. It stops at
`activation_pending` — use `tc harness drain` / `tc harness activate <id>` after
the all-work queue is clear (docs/architecture/harness-improvement.md). Canary
starts only on activate.

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
cadences below (including weekly `harness-improve` unless opted out). Re-run
after CLI changes. Flags: `--dry-run`, `--no-load`, `--without-harness`,
`--jobs-only`, `--sync-env`, `--allow-dirty`, `--skip-agent-wait`. Before
reloading launchd units the installer sets deploy-pause (bootouts StartInterval
jobs), runs `tc harness wait-idle` (default 30m; auto-fails orphaned incomplete
journals), reloads units, then clears the pause and kickstarts deferred jobs;
`--skip-agent-wait` bypasses the idle wait (unsafe). Operator orphan cleanup:
`tc run fail <run-id>`, `tc status --heal-apply`.
The wipe matters: plain `tsc` leaves deleted modules in `dist/`, which would
otherwise ship into the runtime.

`--sync-env` atomically copies repo `.env` → `~/.trenchcoat/env` (mode 600) after
validating required key **names** (values never read); used alone it syncs and
exits without redeploying, otherwise it refreshes env before deploy. This is how
`TAVILY_API_KEY` and the router/destination secrets reach launchd jobs (which
cannot read `~/Documents` under TCC).

Dirty trees are refused by default so `deployment.json` provenance stays exact
(commit + `sourceDirty` + `sourceHash` + config schema + cli/config hashes). Pass
`--allow-dirty` only when you intentionally ship uncommitted edits; `tc status`
warns when the active runtime was built dirty.

Staging safety: the installer builds into a staging dir, validates config with
the staged binary, then atomically swaps `runtime/` (previous kept as
`runtime.prev`). A missing or stale-schema `deployment.json` is flagged by
`tc status`.

To omit the weekly harness job: `./ops/install-launchd.sh --without-harness`.

## Health checks

- `tc status` — shared host health snapshot (`src/orchestrator/health.ts`):
  workspace lock / incomplete / abandoned runs, last success|failure|skip ages
  for key jobs, skip-reason counts from `archive/skips/*.jsonl`, research
  actionable/ambiguous depth, watchlist + wallet counts, X pending/bot-health,
  FC stale streak/fallback from recent receipts, router ingress backlog, and
  deployment provenance (commit, dirty flag, schema compatibility). FOMO appears
  in a separate parallel section and never certifies legacy research/wallet
  health. Health degradation prints as warnings; config/auth/runtime integrity
  failures still exit non-zero. `tc status --json` emits a bounded JSON payload
  of the same snapshot. A job whose last completed run is older than 3x its
  cadence is treated as unhealthy in operator review of that snapshot.
- Telegram `/status` — same host-derived summary (not merely `trenchcoat online`).
- Router health: `curl -sS http://127.0.0.1:8787/healthz` must return
  `{"ok":true}`. Without `com.trenchcoat.router`, staged broadcasts never fan
  out. Logs: `/tmp/trenchcoat.router.*.log`. Kick after env/runtime changes:
  `launchctl kickstart -k gui/$(id -u)/com.trenchcoat.router`. Telegram fanout
  needs both `TELEGRAM_ROUTER_BOT_TOKEN` and `TELEGRAM_ROUTER_CHAT_ID` in
  `~/.trenchcoat/env` (Discord broadcast needs `DISCORD_WEBHOOK_URL`; Discord
  research needs `DISCORD_RESEARCH_BOT_TOKEN` when `chat.discord.enabled`). If err logs show
  missing `better_sqlite3.node`, re-run `./ops/install-launchd.sh` (installer
  rebuilds the native addon after prod install).
- Listener health: the listener touches a heartbeat file every poll cycle;
  `tc status` flags a stale heartbeat (> 15 min). launchd restarts crashes;
  a silently wedged process is caught by the heartbeat and killed by
  the next `tc status --heal` (safe: alpha-queue appends are atomic per
  message, INV-Q1).
- Daily `review` (07:00 local, unchanged cadence) always receives the health
  snapshot plus append-only skip ledgers, so empty queues, silent wallets,
  stale FC, and recurring skips remain in scope even when no agent report
  directory exists.
- Operator Telegram chat: `com.trenchcoat.listener` runs `tc listen`, which keeps
  the Telegram operator bridge alive and spawns a supervised Discord research
  child when `chat.discord.enabled` and `DISCORD_RESEARCH_BOT_TOKEN` are set.
  Discord logs share `/tmp/trenchcoat.listener.*.log` with Telegram. After CLI /
  chat / research / discord code changes, re-run `./ops/install-launchd.sh`
  (deploys `~/.trenchcoat/runtime`, waits for agent idle, then reloads units
  including the listener — no separate `kickstart -k` needed unless you are
  recovering a wedged process after install). Manual kick without the idle gate
  can kill mid-session work; prefer `tc harness wait-idle` first.
  `install-launchd.sh` syncs `agent/AGENTS.md` + `agent/skills/` when passed
  `--sync-skills` (also mirrors into `~/.trenchcoat/discord/agent/` when that
  tree exists). Without it, copy changed voice/skill files manually or agents
  keep stale outbox voice / chat-summary / deferral / alpha-digest text. Stale
  runtime is the usual cause of research asks falling through to a long ask-mode
  lecture instead of
  `Research <subject>? Reply confirm or cancel.` Session id lives in
  `~/.trenchcoat/chat-session.json`. Research asks are confirmation-gated on the
  host; confirmed work runs asynchronously under the workspace lock
  (docs/architecture/chat-agent.md).
- After install reload, `tc status` may show `lock: … STALE` if launchd killed a
  job mid-hold. Next `WorkspaceLock.tryAcquire` clears a dead-pid owner; or remove
  `~/.trenchcoat/agent/.lock` and `.lock.owner` only when `kill -0 <pid>` fails.
- **Discord research** (optional): enabled via config — no separate launchd unit.
  Same `com.trenchcoat.listener` supervises `tc listen discord` as a child process.
  Requires `DISCORD_RESEARCH_BOT_TOKEN` (separate from `DISCORD_WEBHOOK_URL`).
  State under `~/.trenchcoat/discord/`. Watch monitor:
  `com.trenchcoat.job.discord-watchlist-scan` (0/6/12/18 local). After install,
  `launchctl bootstrap` often fails with `Bootstrap failed: 5` — recover with
  bootout → sleep → bootstrap → `kickstart -k`. Cold start may take 10–20s
  before the Discord child logs ready. See
  docs/architecture/discord-research.md.
- **Discord chain integration** (schema 12): exact unknown `slug:address` in an
  allowed channel enqueues `~/.trenchcoat/discord/chain-integrations/` and
  kickstarts `com.trenchcoat.job.discord-chain-integration`
  (`tc discord chains run`). Recovery: `tc discord chains status|retry|fail`.
  During self-deploy the worker stays registered (not bootout) and drain treats
  `deploying` as idle-safe. See docs/architecture/discord-chain-integration.md.
- **Incident remediation** (schema 13): hourly/weekly host lane; disabled by
  default — enable `incident_remediation.enabled` + `schedule_enabled` after
  dry canary (`tc remediations scan|status`). High-risk needs Telegram
  `approve remediation <id>`. See docs/architecture/incident-remediation.md.
- Knowledge rollup: `~/.trenchcoat/agent/state/INDEX.md` must exist (empty
  skeleton is fine). Chat and scan skills read it first; older homes that
  predate `scripts/scaffold-agent.ts` creating the file need a one-time copy
  from repo `agent/state/INDEX.md` (docs/architecture/agent-workspace.md).

## Deploy canary and rollback (operator)

Do **not** install from a dirty tree unless you pass `--allow-dirty` and accept
the `tc status` dirty warning. Never let a dirty deploy overwrite live
`~/.trenchcoat/config.json` from seed (e.g. wiping `farcaster.enabled` /
`bot_fid`) — backup first and restore from `~/.trenchcoat/backups/config-*.json`
if flags disappear. Preferred sequence after a reviewed clean commit:

1. Backup host state/archive (`ops/backup.sh` / `tc backup`).
2. `pnpm typecheck && pnpm lint && pnpm test:all` (plus FOMO shadow suites when
   touching that path).
3. `./ops/install-launchd.sh` (clean tree) — stages, writes schema-2
   `deployment.json`, swaps `runtime/` while keeping `runtime.prev`.
4. Confirm `tc status` shows matching config/runtime schema, commit, and
   `sourceDirty=false`.
5. Canary in order: FC collect with agent skipped (live or labeled fallback, no
   engagement); one narrative-scan (complete journal + chat report); next organic
   list-scan for X settlement; one non-public canary broadcast + `delivery-retry`
   proof; one daily review health/chat snapshot. Keep FOMO in shadow and compare
   metrics separately.

**Rollback:** if journal parsing, host integrity, mutation confinement, router
delivery, or schema migration fails, restore runtime by swapping
`~/.trenchcoat/runtime.prev` back to `runtime` (and matching config backup
under `~/.trenchcoat/backups/`). Do not delete receipts to “undo”; restore
predeploy backup only when migration itself corrupted host state.

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
- **Outcome settlement** — launchd `com.trenchcoat.job.outcomes-settle` every 6h
  (`RunAtLoad`); also runs inside audit. Manual: `tc run outcomes-settle`
  materializes mature source-call + wallet-buy observations into
  `archive/outcomes/`. Source-list-review loads those outcomes and writes lagged
  scores into `sources.json` for callers with `settledCalls > 0`.
  source-call and wallet-buy observations (also invoked before `tc run audit`).
  Missing prices stay pending/excluded and never become invented losses.
- **Narrative broadcasts** — `tc run narrative-scan` (every ~6h). Agent maintains
  `agent/state/narratives/log.jsonl` and proposes outbox items only for new
  slugs; host prunes entries older than `narratives.retention_days` (schema 7,
  default 14). If `~/.trenchcoat/config.json` is still schema 6 on disk,
  `loadConfig` migrates in memory — re-save or copy from repo `config.json` to
  persist `narratives` on disk.
- **Adding a Telegram channel** — add to `~/.trenchcoat/config.json` under
  `telegram_channels` with `mode: "preview"` (preferred). Restart
  **`com.trenchcoat.channels`** (`launchctl kickstart -k gui/$(id -u)/com.trenchcoat.channels`),
  not `com.trenchcoat.listener` (that is operator DMs). Verify within a few
  minutes: logs show `preview:N` and `telegram preview polled`,
  `~/.trenchcoat/agent/alpha-queue/<channel>/` grows, and cursors list the
  real handle (never a stray `telegram` product-blog key unless you meant that
  handle). If `t.me/s/<channel>` returns no messages, switch that entry to
  `"gramjs"` only after a session exists — GramJS auth is still operator-driven.
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
  rejected for engagement (no FYP like allowlist). Trending fallback may still
  feed the agent as `analysis-only` — that is not for-you recovery. Live outage
  notes: `ops/LIVE-E2E-BLOCKERS.md` § Farcaster.
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
