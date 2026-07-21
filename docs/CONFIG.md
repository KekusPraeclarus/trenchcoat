---
description: Operator configuration contract - env vars, the config file, seed formats, tunable thresholds, and the CLI surface. Everything the operator provides or invokes.
scope: project
status: active
last_verified: 2026-07-21
read_when:
  - Implementing src/cli.ts or config loading, or setting up a deployment.
---

# Configuration and CLI

## Environment variables (secrets live here, never in files under the repo)

| Var | Used by | Purpose |
|---|---|---|
| `TRENCHCOAT_CURSOR_BIN` | orchestrator | optional path to `agent` binary |
| `TRENCHCOAT_REPO_ROOT` | harness-improve | absolute path to the git checkout (`.git` + `package.json`). `install-launchd.sh` writes this into `~/.trenchcoat/env` because launchd jobs often start with cwd `/` |
| _(none — Cursor CLI login)_ | orchestrator, chat | `agent login` / `agent status` |
| `TRENCHCOAT_ROUTER_URL` / `TRENCHCOAT_ROUTER_TOKEN` | orchestrator | router intake URL (bare host ok — defaults to `/v1/events`) + legacy bearer env (HMAC is authoritative). Loopback HTTP allowed; off-loopback requires HTTPS |
| `TRENCHCOAT_ROUTER_HMAC_KEY` | orchestrator / router | HMAC signing key for intake (INV-B5) |
| `TELEGRAM_BOT_TOKEN` | chat service | operator chat + outbound DMs |
| `TELEGRAM_OPERATOR_ID` | chat service | the allowlist (INV-B3) — single numeric user id |
| `TELEGRAM_ROUTER_BOT_TOKEN` / `TELEGRAM_ROUTER_CHAT_ID` | router fanout | dedicated broadcast bot + destination chat/channel id |
| `DISCORD_WEBHOOK_URL` | router fanout | Discord webhook for broadcast/lifecycle fanout |
| `DISCORD_RESEARCH_BOT_TOKEN` | discord listener | Gateway bot token for private-guild research (never logged or stored in config) |
| `GOPLUS_APP_KEY` / `GOPLUS_APP_SECRET` | collectors | security gate, EVM chains |
| `COINGECKO_DEMO_KEY` | collectors | trending endpoint |
| `HELIUS_API_KEY` | wallet jobs | Solana finalized wallet feeds |
| `INFURA_API_KEY` | wallet jobs | Ethereum/Base finalized wallet feeds |
| `NEYNAR_API_KEY` | collectors | Farcaster feeds / engagement / research |
| `NEYNAR_WALLET_ID` | auth farcaster --create | App wallet for FID registration (optional) |
| `FARCASTER_APP_FID` / `FARCASTER_APP_MNEMONIC` | auth farcaster --create | Sponsors SignedKeyRequest on create (optional) |
| `TAVILY_API_KEY` | research collectors | optional host-mediated web search (never under `agent/`) |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | GramJS listener | MTProto fallback (session file under `~/.trenchcoat/telegram-session/`) |

Loaded from the process env (launchd plists set them from a mode-600 env file,
see ops/runbook.md). Files under `agent/` never receive secrets (INV-I3); the
Cursor child env is scrubbed of router/Telegram/provider keys via
`scrubChildEnv` (`prop_inv_i3_scrub_*`).

## Config file — `~/.trenchcoat/config.json`

Non-secret operator inputs and tunables. Read at process start by the
orchestrator, collectors, and chat service. Versioned by a `schema` field.
Current schema is **14** (post-fix claim revalidation under
`incident_remediation.revalidation`, INV-S28 / ADR 017; prior schema **13** host
`incident_remediation` lane; prior schema **12** Discord `chat.discord.chain_integration`
host lane; prior schema **11** agent-gated harness defaults on, local integrate /
deferred activation; prior schema **10** `chat.discord` private-guild research
bot section, plus prior schema **9** `fomo` web scrape section with `x_source_review` /
`narrative_source_probation`, plus prior v8 Fomo fields, v7
`narratives.retention_days`, v6 `farcaster` / `research.farcaster_search`, and
v5 `harness_improvement`).
`loadConfig` migrates v1–v13 shapes via `migrateConfigToV14`.
`securityThresholdsFromConfig` maps `gate_thresholds` into scanner/preflight
structs used by both scheduled runs and operator research (security-gate.md).
Use `tc config validate` (in-memory) or `tc config migrate --write` (persist);
`ops/install-launchd.sh` validates the staged runtime before swapping
`~/.trenchcoat/runtime`.

```json
{
  "schema": 14,
  "telegram_channels": [
    {
      "channel": "KashKyshAlpha",
      "mode": "preview"
    },
    {
      "channel": "privatepreview",
      "mode": "gramjs"
    }
  ],
  "twitter": {
    "operator_list_urls": [
      "https://x.com/i/lists/FIRST_ID",
      "https://x.com/i/lists/SECOND_ID"
    ],
    "scrape_home": true,
    "max_pages_per_run": 5,
    "managed_list": {
      "name": "trenchcoat-sources",
      "description": "Sources promoted by trenchcoat",
      "capacity": 250
    },
    "source_lifecycle": {
      "review_interval_hours": 24,
      "max_transitions_per_review": 10,
      "promotion": {
        "min_eligible_calls": 10,
        "min_distinct_tokens": 5,
        "min_coverage": 0.8,
        "min_hit_mean": 0.6,
        "min_hit_lb95": 0.45,
        "min_median_excess": 0.05,
        "max_rug_exposure": 0.1,
        "max_idle_days": 14
      },
      "demotion": {
        "idle_days": 30,
        "rug_exposure": 0.25,
        "min_resolved_for_rug_drop": 4,
        "coverage_floor": 0.5,
        "score_floor": 0.4,
        "consecutive_epochs": 2,
        "readd_cooldown_days": 30,
        "readd_min_new_calls": 5
      }
    },
    "engagement": {
      "enabled": true,
      "likes_per_window": 2,
      "like_window_minutes": 10
    }
  },
  "research": {
    "daily_cap": 3,
    "disambiguation_daily_cap": 10,
    "queue_expiry_days": 14,
    "revisit_default_days": 7,
    "web_search": { "enabled": true, "max_queries_per_run": 3 },
    "twitter_search": {
      "enabled": true,
      "max_pages_per_query": 2,
      "max_posts": 40,
      "recent_window_hours": 48
    },
    "farcaster_search": {
      "enabled": false,
      "max_casts": 40,
      "recent_window_hours": 48
    }
    // farcaster_search: watchlist-scan only; operator/queue research dossiers skip FC
  },
  "broadcast": {
    "daily_budget": 5,
    "urgent_ceiling": 10,
    "discord_distiller": { "enabled": false, "daily_cap": 10 },
    "telegram_overview": { "enabled": false, "daily_cap": 10 },
    "worthiness": { "enabled": true, "model": "composer-2.5-fast" }
  },
  // daily_budget / urgent_ceiling = Discord message caps only (Telegram uncapped after validation)
  // discord_distiller / telegram_overview daily_cap = LLM session caps (shared used counter in archive)
  // worthiness = host approve/reject gate before stage (fail-closed; default composer-2.5-fast; ADR 014)
  "narratives": { "retention_days": 14 },
  "source_safety": { "intent_classifier_daily_cap": 20 },
  "farcaster": {
    "enabled": false,
    "scrape_for_you": true,
    "max_items_per_feed": 25,
    "follow_graph": { "capacity": 250 },
    "engagement": {
      "enabled": true,
      "likes_per_window": 2,
      "like_window_minutes": 10
    }
  },
  "indicators": {
    "feature_spec_version": 1,
    "rsi_period": 14,
    "rsi_timeframes_minutes": [60, 240],
    "rsi_overbought": 70,
    "rsi_min_active_bars": 10
  },
  "gate_thresholds": {
    "sell_tax_max": 0.20,
    "lp_locked_min": 0.80,
    "holder_top10_max": 0.50,
    "liquidity_floor_usd": 30000,
    "txns_24h_min": 150,
    "fdv_liquidity_max": 100,
    "liquidity_delta_min": -0.30
  },
  "audit": {
    "horizons_hours": [24, 72, 168],
    "headline_horizon_hours": 72,
    "outcome_settlement_hours": 6,
    "execution_bar_minutes": 5,
    "execution_model_version": 1,
    "execution_fee_bps_per_side": 50,
    "hit_threshold": 0.20,
    "source_score_half_life_days": 30,
    "source_score_prior_strength": 10,
    "source_call_dedupe_hours": 24,
    "attribution_lookback_days": 7,
    "rsi_promotion": {
      "min_ground_truth_events": 100,
      "min_holdout_events": 40,
      "confidence_level": 0.95
    }
  },
  "retention": { "inbox_archive_days": 30, "run_archive_days": 90, "chat_reports_days": 30 },
  "chat": { "idle_timeout_minutes": 30, "research_confirm_ttl_minutes": 15 },
  "wallets": {
    "deterministic_weight": 0.8,
    "llm_weight": 0.2,
    "discovery_interval_hours": 6,
    "max_transitions_per_review": 20,
    "promotion": { "min_blended": 0.7, "min_deterministic": 0.65 },
    "drop": { "blended_floor": 0.45, "deterministic_floor": 0.4 }
  },
  "router": {
    "bind_host": "127.0.0.1",
    "bind_port": 8787
  }
}
```

`wallets` weights must sum to 1 (ADR 002). `router` bind address is local intake
only; HMAC/auth secrets stay in env (`TRENCHCOAT_ROUTER_*`, ADR 001). Full
defaults live in `config/seed.example.json` and `src/lib/config.ts`.

### `harness_improvement` (schema 11)

Agent-gated self-improvement loop (ADR 005). Schema 11 defaults the feature on
for new installs; migration preserves explicit `enabled:false` /
`schedule_enabled:false` from older configs.

| Field | Default | Role |
|---|---|---|
| `enabled` | `true` | Master switch for propose / prepare / canary / activate CLI |
| `schedule_enabled` | `true` | Allow the `harness-improve` job / launchd |
| `integrate_local_main` | `true` | Fast-forward local `main` after implementation approval |
| `deploy_runtime` | `true` | Deploy host runtime after integrate |
| `defer_agent_activation` | `true` | Schedule writes pending agent deploy; no live swap |
| `test_command` | `test:all` | `pnpm run <script>` inside the worktree |
| `planner_model` / `reviewer_model` / `builder_model` | `composer-2.5` | Agent models |
| `require_two_epochs` | `true` | Distinct sealed development + holdout epochs with signals |
| `allocation_bps` | `1000` | Canary traffic share (10%) when activation starts canary |
| `min_events` / `min_holdout_events` / `min_mature_paired` | `40` / `20` / `40` | Sample floors |
| `one_active_experiment` | `true` | Skip schedule while a canary is active |
| `auto_open_pr` | `false` | Deprecated; PR path removed from schedule |

### `incident_remediation` (schema 13+)

Host-owned hourly/weekly ops remediation (ADR 017 / INV-S27). Defaults
**disabled** for safe rollout. Schema **14** adds nested `revalidation`
(INV-S28 post-fix claim audit).

| Field | Default | Role |
|---|---|---|
| `enabled` | `false` | Master switch |
| `schedule_enabled` | `false` | Allow launchd hourly/weekly jobs |
| `hourly_interval_s` | `3600` | Hourly scan cadence |
| `triage_model` / `diagnose_model` / `review_model` | `composer-2.5-fast` | Read-only agent models |
| `propose_model` / `build_model` | `cursor-grok-4.5-high` | Plan/build models |
| `max_active` | `1` | One active remediation |
| `max_immediate_builds_per_utc_day` | `2` | Daily build cap |
| `max_origin_move_rebuilds` | `1` | Rebuilds when origin moves |
| `max_weekly_deferred` | `1` | Weekly deferred items per run |
| `approval_ttl_hours` | `24` | High-risk Telegram approval TTL |
| `max_evidence_bytes` / `max_diff_lines` | `100000` / `400` | Evidence and diff bounds |
| `revalidation.enabled` | `true` | Post-fix claim audit (parent `enabled` still required) |
| `revalidation.required_healthy_observations` | `2` | Healthy post-deploy observations per affected source |
| `revalidation.max_rounds` | `3` | Inconclusive retry cap |
| `revalidation.max_wait_hours` | `24` | Recovery / inconclusive wait cap |
| `revalidation.evaluate_model` / `review_model` | `composer-2.5-fast` | Unanimous invalidation reviewers |
| `revalidation.auto_correct` | `true` | Stage destination-aware `finding.correction` events |

### `narratives` (schema 7)

Rolling narrative log retention for `state/narratives/log.jsonl`.

| Field | Default | Role |
|---|---|---|
| `retention_days` | `14` | Host prunes log lines whose `lastSeen` is older than this after each `narrative-scan` |

### `review` (schema 7)

Knowledge-distillation job scope.

| Field | Default | Role |
|---|---|---|
| `lookback_days` | `7` | Sealed complete runs considered for path-only report manifests |
| `max_reports` | `30` | Cap on report manifests per review run (newest first) |

### `fomo` (schema 9)

Authenticated `fomo.family` web scrape for trader nomination and signal scans.
Defaults keep the integration fully off. Scheduled jobs also fail closed unless
`archive/provider-evaluations/fomo/gates.json` is fresh and the relevant gate is
`pass`. Burner session via `pnpm dev:cli auth fomo`. See
[knowledge/fomo-family.md](knowledge/fomo-family.md).

| Field | Default | Role |
|---|---|---|
| `enabled` | `false` | Master switch; false ⇒ no Fomo navigation |
| `shadow_mode` | `true` | Snapshots/receipts only; no wallet, research-queue, X-nomination, watchlist, engagement, or broadcast mutation |
| `daily_navigation_budget` | `200` | Local ledger cap on page navigations |
| `trader_sync.enabled` | `false` | Lane A wallet nomination job |
| `signal_scan.enabled` | `false` | Lane B signal job |
| `signal_scan.feed` / `trending` / `alerts` / `convergence` / `pressure` | `false` | Per-signal capability flags |
| `signal_scan.max_enqueues_per_day` | `3` | Research-queue writes per UTC day (native/wrap mints never count) |
| `theses.enabled` | `false` | Thesis attachment (adapter-ready; runtime off until gate pass) |
| `x_source_review.enabled` | `false` | Classify Fomo-nominated X accounts |
| `x_source_review.max_pending` | `100` | Pending nomination queue cap |
| `x_source_review.max_reviews_per_day` | `4` | Reviews per UTC day |
| `x_source_review.daily_history_page_budget` | `20` | Shared X history/probation page budget (`archive/provider-usage/twitter/fomo-source-review/`) |
| `x_source_review.lookback_days` / `max_posts_per_review` / `max_pages_per_review` | `90` / `200` / `5` | History scrape bounds |
| `x_source_review.min_posts` / `min_active_days` / `min_role_evidence_posts` | `20` / `3` / `5` | Classification sample floors |
| `narrative_source_probation.enabled` | `false` | Narrative-source probation scan/review |
| `narrative_source_probation.max_profiles_per_scan` / `max_pages_per_profile` | `5` / `1` | Round-robin live scan bounds |
| `narrative_source_probation.daily_profile_page_budget` | `20` | Shares the X page-budget ledger with history review |
| `narrative_source_probation.probation_days` | `14` | Utility measurement window |
| `narrative_source_probation.min_accepted_contributions` / `min_distinct_narratives` | `3` / `2` | Follow eligibility floors |
| `narrative_source_probation.demotion_idle_days` | `28` | Idle unfollow trigger |

### `retention`

Agent-workspace pruning on every completed run (`retainWorkspaceArtifacts`).
Never deletes under the host `archive/` tree.

| Field | Default | Role |
|---|---|---|
| `inbox_archive_days` | `30` | Age-prune `agent/inbox/<run-id>/` dirs |
| `chat_reports_days` | `30` | Age-prune `agent/reports/chat/*` |
| `run_archive_days` | `90` | Reserved for archive run GC (not applied by workspace retention; see snapshot-archive.md) |

Threshold semantics live in the doc owning each subsystem (security-gate.md,
audit-metrics.md, research-queue.md); the config only carries values. A config
change that alters semantics is a doc change first.

## Seed file — operator cold start

Config (`config/seed.example.json` → `~/.trenchcoat/config.json`) holds tunables
and social collector settings. The **operator seed** is a separate file:

`config/operator-seed.example.json`

```json
{
  "schema": 1,
  "watchlist": [
    { "chain": "solana", "token_address": "…", "thesis": "one line" }
  ],
  "sources": ["twitter:@handle", "telegram:channelname"],
  "wallets": [
    { "chain": "solana", "address": "…", "note": "optional" }
  ]
}
```

**Wallets (implemented):** `tc wallets seed <file>` (or
`tc init --operator-seed <file>`) writes `agent/state/wallets.json` with each
address as `tracking-probation` and `reasonCode: operator-seed`. Chains must
support wallet tracking (`solana`, `ethereum`, `base`, `robinhood`). Refuses a non-empty
`wallets.json`. Archives a receipt under `archive/wallet-seeds/` (router
`wallet.lifecycle` fanout for seeds still deferred; review job stages live adds/drops).
Seed at least one eligible wallet before wallet scan jobs can produce evidence.
Discovery also requires a tracking or watching watchlist entry. Discovery and
scan agents are evidence-only and cannot change wallet state, scores, cursors,
or lifecycle.

**Watchlist / sources:** schema accepted in the operator seed file; cold-start
application is not wired yet — only wallets are applied today.

## CLI surface (`trenchcoat`, alias `tc`)

| Command | Behaviour |
|---|---|
| `tc run <job>` | run one job (cron entry point); refuses if the workspace writer lock is held. Jobs include `list-scan`, `farcaster-scan`, `source-list-review`, `fc-source-review`, `wallet-discovery`, `wallet-scan-solana`, `wallet-scan-evm`, `wallet-review`, `harness-improve`, plus the scan/research/audit set in orchestrator.md |
| `tc config validate` | migrate+parse config in memory; no write |
| `tc config migrate --write` | persist schema-8 migration to `~/.trenchcoat/config.json` |
| `tc watchlist remove <chain:token> --subject <symbol> --reason <text>` | host removal of ignored/revisit/dropped entries; reconciles `state/INDEX.md` |
| `tc probe farcaster` | Neynar feed probe + dynamic signer status + FC lifecycle/engagement summary |
| `tc auth farcaster --create --fname <name>` | programmatic bot account + signer (no app tap) |
| `tc auth farcaster --fid <n> --username <name> --mnemonic-stdin` | attach signer to existing FID (mobile approve, or OP ETH on custody for host `KeyGateway.add`) |
| `tc fc-source review [--dry-run] [--no-sync]` | FC follow-graph lifecycle review |
| `tc fc-source seed <path> [--dry-run]` | operator seed for FC managed follows (`config/fc-source-seed.example.json`) |
| `tc fc-source sync [--dry-run]` | apply desired follow graph with verification receipt |
| `tc fc-engagement status` / `dry-run <run-id>` | FC like engagement probe |
| `tc init [--seed <config>] [--operator-seed <file>]` | writes `~/.trenchcoat/config.json` from config seed; optional operator wallet seed |
| `tc wallets seed <file>` | operator-seed wallets into empty `state/wallets.json` |
| `tc auth twitter` | headful interactive re-auth (documented sandbox exception) |
| `tc auth twitter --create-managed-list` | one-time private managed source list; persists list id/url (ADR 004) |
| `tc probe twitter` | scrape all configured targets + lifecycle summary; no membership mutations |
| `tc source-list review [--dry-run] [--no-sync]` | deterministic promote/demote; dry-run skips state and X writes |
| `tc source-list sync` | sync desired managed membership to the persisted list id only |
| `tc harness propose --epoch <id>` | one hypothesis from a sealed scorecard (ADR 005) |
| `tc harness run` / `tc run harness-improve` | scheduled pipeline: branch + tests + open PR (no merge) |
| `tc harness prepare\|evaluate\|canary\|promote\|rollback\|status` | confined worktree + holdout + bounded canary |
| `tc x-engagement status` | like throttle window usage, follow/like counts, `x-bot-health.json` |
| `tc x-engagement dry-run <run-id>` | show which bot choices would apply using live inbox or sealed archive `x-fyp-eligible.json`; no X mutations |
| `tc research <subject>` | operator-priority enqueue + locked research run (`chain:address` preferred); `--skip-agent` / `--dry-collect` supported |
| `tc undock <id>` / `tc confirm <id>` | terminal exoneration decisions (INV-S13) |
| `tc listen telegram` | Telegram listener + async research pump after operator confirm |
| `tc listen` | KeepAlive operator listeners (Telegram + Discord research when enabled) |
| `tc listen discord` | Discord Gateway research only (debug) |
| `tc discord watchlist scan` | six-hour material-change monitor for Discord watch subscriptions |
| `tc discord chains run\|status\|retry\|fail\|continue` | host chain-integration worker / recovery / post-deploy handoff |
| `tc listen channels` | Telegram alpha-channel poller (~60s) + immediate `telegram-alpha` agent per new message; cursors under `~/.trenchcoat/telegram-channels/` |
| `tc listen x-scan` | Persistent X round-robin (FYP → lists, cursor stop, 5–30m between rounds); cursors under `~/.trenchcoat/x-scan/` |
| `tc auth telegram-channels` | Scaffold GramJS session path under `~/.trenchcoat/telegram-session/` |
| `tc backup` | archive file-list backup + sampled hashes → `~/.trenchcoat/backups/` (weekly via `ops/backup.sh`) |
| `tc status` | shared health snapshot (lock/runs/jobs/skips/queues/X/FC/router/deploy); Discord section when enabled; `--json` bounded payload; health warnings non-fatal |

### `chat.discord` (schema 10+)

Private-guild research bot. Disabled by default. When enabled requires
`guild_id` and 1–20 unique `channel_ids`. Caps: `per_user_daily_cap` (default 5),
`server_daily_cap` (20), `max_active_per_user` (default 5 — max queued+running+
awaiting-chain per user; global FIFO, one research at a time). Daily caps charge
`queued` / `running` / `awaiting-chain` / `completed` only — terminal `failed`
requests do not consume quota.
`model` (default `composer-2.5-fast`, initial Discord research reply only;
material watch updates use host `composer-2.5` writer),
`max_watched_tokens` (500), `max_subscribers_per_token` (100). Watch
subscriptions last `watch_days` (30); monitor cadence `watch_scan_hours` (6).
State lives under `~/.trenchcoat/discord/` — see
[architecture/discord-research.md](architecture/discord-research.md).

### `chat.discord.chain_integration` (schema 12)

Host lane for exact unknown `slug:address` (ADR 016). Defaults: `enabled` true,
`max_attempts_per_utc_day` 3, `max_concurrent` 1, models
`composer-2.5` / `cursor-grok-4.5-high` / `composer-2.5-fast`,
`provider_max_attempts` 5, `repair_max_rounds` 2, `deploy_max_attempts` 2,
`phase_timeout_ms` 1800000. See
[architecture/discord-chain-integration.md](architecture/discord-chain-integration.md).

### `chat.discord.tracking`

NL idea-tracking requests (ADR 018 / ADR 019, INV-D3–D8). Default `enabled: true`. Models
`intent_model` / `match_model` default `composer-2.5`; `mention_review_model`
defaults `composer-2.5-fast`. Cap `max_active_per_user` 10, `ttl_days` 30,
`expiry_bundle_hours` 48, `pending_capacity_ttl_hours` 48,
`tentative_confirm_window_hours` 24, `expiry_reply_window_days` 7,
`mention_review_blacklist_days` 7. Alerts fire only after ticker/CA validation +
deep research qualification (non-reply channel message with stored `shortLabel`).
State: `~/.trenchcoat/discord/tracking.json`. See
[architecture/discord-tracking.md](architecture/discord-tracking.md).

Exit codes: `0` success, `1` run never started (env/config problem,
`CursorAgentError`), `2` run failed mid-flight (inspect transcript), `3` lock
held / refused. The two failure kinds are never conflated (orchestrator.md).
