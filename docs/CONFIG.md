---
description: Operator configuration contract - env vars, the config file, seed formats, tunable thresholds, and the CLI surface. Everything the operator provides or invokes.
scope: project
status: active
last_verified: 2026-08-31
read_when:
  - Implementing src/cli.ts or config loading, or setting up a deployment.
---

# Configuration and CLI

## Environment variables (secrets live here, never in files under the repo)

| Var | Used by | Purpose |
|---|---|---|
| `TRENCHCOAT_CURSOR_BIN` | orchestrator | optional path to `agent` binary |
| `TRENCHCOAT_REPO_ROOT` | harness-improve / harness-meta-improve / Telegram `/plan`+`/agent` | absolute path to the git checkout (`.git` + `package.json`). `install-launchd.sh` writes this into `~/.trenchcoat/env` because launchd jobs often start with cwd `/`. Telegram code turns also require `ops/` + `docs/` (ADR 040) |
| _(none — Cursor CLI login)_ | orchestrator, chat | `agent login` / `agent status` |
| `TRENCHCOAT_ROUTER_URL` / `TRENCHCOAT_ROUTER_TOKEN` | orchestrator | router intake URL (bare host ok — defaults to `/v1/events`) + legacy bearer env (HMAC is authoritative). Loopback HTTP allowed; off-loopback requires HTTPS |
| `TRENCHCOAT_ROUTER_HMAC_KEY` | orchestrator / router | HMAC signing key for intake (INV-B5) |
| `TELEGRAM_BOT_TOKEN` | chat service | operator chat + outbound DMs |
| `TELEGRAM_OPERATOR_ID` | chat service | the allowlist (INV-B3) — single numeric user id |
| `TELEGRAM_ROUTER_BOT_TOKEN` / `TELEGRAM_ROUTER_CHAT_ID` | router fanout | dedicated broadcast bot + destination chat/channel id |
| `DISCORD_WEBHOOK_URL` | router fanout | Discord webhook for broadcast/lifecycle fanout |
| `DISCORD_RESEARCH_BOT_TOKEN` | discord listener | Gateway bot token for private-guild research (never logged or stored in config) |
| `DISCORD_OPERATOR_USER_ID` | discord listener | sole user whose broadcast reactions count as feedback (ADR 043, INV-B6); needs View Channel, Read Message History, Add Reactions in the feedback channel |
| `GOPLUS_APP_KEY` / `GOPLUS_APP_SECRET` | collectors | security gate, EVM chains |
| `COINGECKO_DEMO_KEY` | collectors | trending endpoint |
| `HELIUS_API_KEY` | wallet jobs | Solana finalized wallet feeds |
| `INFURA_API_KEY` | wallet jobs | Ethereum/Base finalized wallet feeds |
| `SOLANATRACKER_API_KEY` | collectors | optional Solana OHLCV fallback when Gecko fails (preferred over Birdeye on Solana) |
| `BIRDEYE_API_KEY` | collectors | optional OHLCV fallback — Solana last resort after SolanaTracker; primary fallback for ethereum/base/bsc |
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
Current schema is **29** (broadcast feedback `history_days` default 60 — ADR 043; prior
schema **28** FOMO platform follows vs X review — ADR 048; prior
schema **27** pump.fun feed scan — ADR 047; earlier discovery:
`research.social_cashtag_bridge`
and `new_pools_feed` — ADR 046; prior schema **25** retention sweeps for
purged alpha-ack tombstones and dormant narrative dossiers under
`retention.alpha_ack_days` / `retention.narrative_dossier_days` — ADR 044,
ADR 045; prior schema **24** one clarifying Discord reply per forming
suggestion under `incident_remediation.discord_suggestions.followup_enabled`
— ADR 025; prior schema **23** narrative evidence quality under
`narratives.evidence_quality` — ADR 042, and operator broadcast feedback under
`broadcast.feedback` — ADR 043; new installations get
`research.farcaster_search.enabled=false`; prior schema **22** unified
Telegram/Discord broadcast fanout — ADR 041;
drops `broadcast.daily_budget`, `urgent_ceiling`, `discord_distiller`; prior
schema **21** harness meta lane operator controls under
`harness_improvement.meta_*` — ADR 039; prior schema **20** Discord
`chat.discord.wallet_signals` confluence — ADR 035; prior schema **19**
token-cost host gates: distill LLM budget fractions, chat turn/prompt caps —
ADR 034; prior schema **18** daily Telegram narrative digest under
`broadcast.telegram_digest`; prior schema **17** (passive Discord suggestion
intake under `incident_remediation.discord_suggestions`, INV-S27 / ADR 025;
prior schema **16** drops Discord research caps and adds conversation; prior
**14** post-fix claim revalidation under `incident_remediation.revalidation`,
INV-S28 / ADR 017; prior schema **13** host `incident_remediation` lane; prior
schema **12** Discord `chat.discord.chain_integration` host lane; prior schema
**11** agent-gated harness defaults on, local integrate / deferred activation;
prior schema **10** `chat.discord` private-guild research bot section, plus
prior schema **9** `fomo` web scrape section with `x_source_review` /
`narrative_source_probation`, plus prior v8 Fomo fields, v7
`narratives.retention_days`, v6 `farcaster` / `research.farcaster_search`, and
v5 `harness_improvement`).
`loadConfig` migrates v1–v28 shapes via `migrateConfigToV29`.
`securityThresholdsFromConfig` maps `gate_thresholds` into scanner/preflight
structs used by both scheduled runs and operator research (security-gate.md).
Use `tc config validate` (in-memory) or `tc config migrate --write` (persist);
`ops/install-launchd.sh` validates the staged runtime before swapping
`~/.trenchcoat/runtime`.

```json
{
  "schema": 29,
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
    },
    // farcaster_search: watchlist-scan only; operator/queue research dossiers skip FC
    "social_cashtag_bridge": {
      "enabled": true,
      "min_authors": 2,
      "window_days": 7,
      "max_enqueues_per_run": 3,
      "max_clusters": 500,
      "skip_promotional": true
    }
  },
  "new_pools_feed": {
    "enabled": true,
    "shadow_mode": false,
    "chains": ["solana", "ethereum", "base", "robinhood"],
    "gecko_page": 1,
    "max_candidates_per_run": 40,
    "max_enqueues_per_run": 3,
    "max_enqueues_per_day": 5,
    "min_pool_age_minutes": 15,
    "max_pool_age_hours": 24
  },
  "broadcast": {
    "telegram_overview": { "enabled": false, "daily_cap": 50, "llm_budget_fraction": 0.5, "hot_day_llm_budget_fraction": 0.25 },
    "telegram_digest": { "enabled": false },
    "hot_day_min_staged_events": 20,
    "worthiness": { "enabled": true, "model": "composer-2.5-fast" },
    "feedback": {
      "enabled": false,
      "channel_id": "1000000000000000002",
      "followup_ttl_hours": 72,
      "followup_model": "composer-2.5-fast",
      "history_days": 60,
      "reconcile_max_messages": 100,
      "candidate_min_policy_examples": 5,
      "candidate_min_completed_down": 3,
      "candidate_min_preference_pairs": 2
    }
  },
  // telegram_overview = intraday short topic paragraph LLM (config key preserved; ADR 026)
  //   daily_cap = LLM sessions only (hot-day ops: 50); message count uncapped after validation
  //   llm_budget_fraction = fraction of daily_cap that may open an LLM distill session (rest use fallback; ADR 034)
  //   hot_day_llm_budget_fraction = tighter fraction when staged events this run ≥ hot_day_min_staged_events
  // telegram_digest = host-only daily narrative map at 04:00 Europe/London (schema 18; ADR 041)
  // Discord receives the same rendered text as Telegram leaders (ADR 041)
  // worthiness = host approve/reject gate before stage (fail-closed; default composer-2.5-fast; ADR 014)
  // feedback = operator reactions on delivered Discord broadcasts (ADR 043, INV-B6)
  //   channel_id must appear in chat.discord.channel_ids, and chat.discord.enabled must be true
  //   DISCORD_OPERATOR_USER_ID names the sole user whose reactions count
  //   followup_ttl_hours is fixed at 72; candidate_* set the sample floors for a tuning candidate
  "narratives": {
    "retention_days": 14,
    "evidence_quality": {
      "enabled": true,
      "max_promotional_share": 0.5,
      "min_independent_authors": 2,
      "min_fresh_posts": 2,
      "primary_source_handles": []
    }
  },
  // evidence_quality = curation floors for the social posts behind a narrative claim (ADR 042)
  //   a claim needs min_fresh_posts eligible posts, min_independent_authors authors,
  //   and a promotional share at or below max_promotional_share
  //   primary_source_handles adds a signal only; it never bypasses the author floor
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
  "retention": {
    "inbox_archive_days": 30, "run_archive_days": 90, "chat_reports_days": 30,
    "alpha_ack_days": 30, "narrative_dossier_days": 120
  },
  "chat": { "idle_timeout_minutes": 30, "research_confirm_ttl_minutes": 15 },
  "wallets": {
    "deterministic_weight": 0.8,
    "llm_weight": 0.2,
    "discovery_interval_hours": 6,
    "max_transitions_per_review": 20,
    "promotion": { "min_blended": 0.7, "min_deterministic": 0.65 },
    "drop": { "blended_floor": 0.45, "deterministic_floor": 0.4 },
    "runner_discovery": {
      "enabled": false,
      "shadow_mode": true,
      "interval_minutes": 30,
      "max_age_hours": 24,
      "min_liquidity_usd": 50000,
      "min_return_6h": 1.0,
      "min_volume_6h_usd": 250000,
      "chains": ["solana", "ethereum", "base", "robinhood"]
    },
    "convergence": {
      "enabled": false,
      "shadow_mode": true,
      "min_wallets": 4,
      "window_minutes": 15,
      "max_alerts_per_day": 10,
      "max_enqueues_per_day": 5
    }
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

### `harness_improvement` (schema 11 + schema 21 meta_*)

Agent-gated self-improvement loop (ADR 005). Schema 11 defaults the feature on
for new installs; migration preserves explicit `enabled:false` /
`schedule_enabled:false` from older configs. Schema **21** adds meta-lane
operator controls (ADR 039); meta-utility floors/weights stay code constants.

| Field | Default | Role |
|---|---|---|
| `enabled` | `true` | Master switch for propose / prepare / canary / activate CLI |
| `schedule_enabled` | `true` | Allow the `harness-improve` job / launchd |
| `integrate_local_main` | `true` | Fast-forward local `main` after implementation approval |
| `push_origin` | `true` | Push candidate → `origin/main` before local ff (kill switch `false`) |
| `deploy_runtime` | `true` | Deploy host runtime after integrate |
| `defer_agent_activation` | `true` | Schedule writes pending agent deploy; no live swap |
| `test_command` | `test:all` | `pnpm run <script>` inside the worktree |
| `planner_model` / `reviewer_model` / `builder_model` | `composer-2.5` | Agent models |
| `require_two_epochs` | `true` | Distinct sealed development + holdout epochs with signals (preflighted) |
| `allocation_bps` | `1000` | Canary traffic share (10%) when activation starts canary |
| `min_events` / `min_holdout_events` / `min_mature_paired` | `40` / `20` / `40` | Sample floors (preflighted before propose; holdout replay remains authoritative) |
| `one_active_experiment` | `true` | Skip schedule while a canary or mid-flight peer lane is active (preflighted) |
| `auto_open_pr` | `false` | Deprecated; PR path removed from schedule |
| `meta_enabled` | `true` | Master switch for improver-config meta lane |
| `meta_schedule_enabled` | `true` | Allow `harness-meta-improve` job |
| `meta_min_paired_trials` | `8` | Operator hint; host utility still requires ≥8 valid pairs in code |
| `meta_schedule_days` | `30` | Intended meta wakeup cadence |
| `meta_require_operator_promotion` | `true` | Refuse auto-promote; require `tc harness meta promote`. First `promotion_eligible` also one-shot Telegram-pings the operator with next steps. |

### Repo `config/harness-improver.json` (ADR 039)

Checked-in, schema-validated improver knobs (not under `~/.trenchcoat/config.json`,
never synced into `agent/`). Literal meta-lane allowlist path. Closed keys only:

| Block | Bounds (fail closed) |
|---|---|
| `mining.minClusterSize` | 3–20 |
| `mining.maxClusters` | 1–8 |
| `mining.maxKeepPatterns` | 1–3 |
| `mining.maxEvidencePerPattern` | 1–32 |
| `mining.signalKeyPrefixes` | known signal-prefix allowlist only |
| `propose.weakMetricPriority` | closed metric keys |
| `propose.maxRationaleChars` / `planAddendum` | length-capped (addendum ≤500) |

Unknown keys reject. Cannot express paths, commands, models, floors, evaluator
settings, or allowlist expansion. Shadow meta candidates edit a copy under
`harness-improvements/meta/<id>/` until operator promote ff-integrates the
repo file. Defaults live in `src/harness/improver-config.ts` when the file is
absent.

### `incident_remediation` (schema 13+)

Host-owned hourly/weekly ops remediation (ADR 017 / INV-S27). Defaults
**disabled** for safe rollout. Schema **14** adds nested `revalidation`.
Schema **17** adds nested `discord_suggestions` (ADR 025): passive conversation-thread
scan of configured Discord channels for buildable suggestions. Defaults
`discord_suggestions.enabled=false`. When enabled, requires parent
`incident_remediation.enabled` and `DISCORD_RESEARCH_BOT_TOKEN`. Empty
`channel_ids` uses `chat.discord.channel_ids`. CLI: `tc remediations suggestions`.
(INV-S28 post-fix claim audit). Schema **24** adds
`discord_suggestions.followup_enabled` (default `true`): the scan posts one
host-rendered clarifying question in the thread on the first `forming` round.
Set it to `false` to keep the lane silent on Discord.

Host live-recovery floors (not configurable): log/health/skip candidates whose mapped jobs are healthy are dropped as `already-recovered`. A terminal fingerprint reopens only when a mapped job is degraded. Discord suggestions skip this floor.

| Field | Default | Role |
|---|---|---|
| `enabled` | `false` | Master switch |
| `schedule_enabled` | `false` | Allow launchd hourly/weekly jobs |
| `hourly_interval_s` | `3600` | Hourly scan cadence |
| `triage_model` / `diagnose_model` / `review_model` | `composer-2.5-fast` | Read-only agent models |
| `propose_model` / `build_model` | `cursor-grok-4.5-high` | Propose (ask mode, ADR 029) / build models |
| `max_active` | `1` | One active remediation |
| `max_immediate_builds_per_utc_day` | `2` | Daily build cap |
| `max_origin_move_rebuilds` | `1` | Rebuilds when origin moves |
| `max_pre_review_revises` | `5` | Auto re-propose after pre-review `revise` before operator failure notify |
| `max_weekly_deferred` | `1` | Weekly deferred items per run |
| `approval_ttl_hours` | `24` | High-risk Telegram approval TTL |
| `max_evidence_bytes` / `max_diff_lines` | `100000` / `400` | Evidence and diff bounds |
| `revalidation.enabled` | `true` | Post-fix claim audit (parent `enabled` still required) |
| `revalidation.required_healthy_observations` | `2` | Healthy post-deploy observations per affected source |
| `revalidation.max_rounds` | `3` | Inconclusive retry cap |
| `revalidation.max_wait_hours` | `24` | Recovery / inconclusive wait cap. Skip when every affected source kind is absent from the ledger |
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

### `fomo` (schema 9, follows in schema 28)

Authenticated `fomo.family` web scrape for trader nomination and signal scans.
Defaults keep the integration fully off. Scheduled jobs also fail closed unless
`archive/provider-evaluations/fomo/gates.json` is fresh and the relevant gate is
`pass`. Burner session via `pnpm dev:cli auth fomo`. See
[knowledge/fomo-family.md](knowledge/fomo-family.md) and
[ADR 048](adr/048-fomo-follows-vs-x-review.md).

| Field | Default | Role |
|---|---|---|
| `enabled` | `false` | Master switch; false ⇒ no Fomo navigation |
| `shadow_mode` | `true` | Snapshots/receipts only; no wallet, research-queue, X-nomination, FOMO follow, watchlist, engagement, or broadcast mutation |
| `daily_navigation_budget` | `200` | Local ledger cap on page navigations |
| `trader_sync.enabled` | `false` | Leaderboard sync for FOMO follows / linked-X nominations (no wallets) |
| `trader_sync.max_handles` | `15` | Leaderboard handles considered for follow and linked-X upsert |
| `follows.enabled` | `false` | Host follow on fomo.family; live migrate turns this on when FOMO is already live |
| `follows.max_follows_per_run` | `5` | New FOMO follows per trader-sync run |
| `follows.max_following` | `80` | Cap on stored FOMO followed handles |
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

### `pump` (schema 27)

Authenticated [pump.fun](https://pump.fun) SPA scrape. Defaults keep the
lane off. Jobs also fail closed unless
`archive/provider-evaluations/pump/gates.json` is fresh and `provider` is
`pass`. Burner session via `tc auth pump`. See
[knowledge/pump-fun.md](knowledge/pump-fun.md) and
[ADR 047](adr/047-pump-feed-scan.md).

| Field | Default | Role |
|---|---|---|
| `enabled` | `false` | Master switch; false skips `pump-scan` |
| `shadow_mode` | `true` | Archives calls and writes receipts. No mutations. No research enqueue |
| `daily_navigation_budget` | `200` | Local ledger cap on page navigations. Live smoke does not debit this ledger |
| `max_pages_per_feed` | `5` | Doomscroll cap after the per-tab cursor |
| `following_min_follows` | `10` | Following tab runs only at this follow count |
| `max_profile_chart_pages` | `5` | Profile call-chart visits per run |
| `engagement.likes_per_window` | `2` | Like cap per window |
| `engagement.like_window_minutes` | `10` | Like window length |
| `engagement.max_follows_per_run` | `3` | Follow cap per `pump-scan` |
| `leaderboard.enabled` | `true` | Scrape handles only. No wallet nomination |
| `leaderboard.max_handles` | `50` | Leaderboard row cap |
| `research.max_enqueues_per_day` | `3` | Host enqueue from Following then Top |
| `calls.min_age_hours` | `24` | Peak settle wait after a call |

### `research.social_cashtag_bridge` (schema 26)

Host bridge after `list-scan` / `farcaster-scan`. Merges cashtag authors across
runs and enqueues research when the author floor holds. See
[ADR 046](adr/046-earlier-token-discovery.md) and
[research-queue.md](architecture/research-queue.md).

| Field | Default | Role |
|---|---|---|
| `enabled` | `true` | Master switch for the persistent cashtag bridge |
| `min_authors` | `2` | Independent authors required before resolve/enqueue |
| `window_days` | `7` | Author-merge window |
| `max_enqueues_per_run` | `3` | Cap on bridge enqueues per scan run |
| `max_clusters` | `500` | Cap on stored clusters in `social-cashtag-clusters.json` |
| `skip_promotional` | `true` | Drop promotional-shaped cashtag text before merge |

Shared model disambiguation uses `research.disambiguation_daily_cap`.

### `new_pools_feed` (schema 26)

Live GeckoTerminal new-pools path on `list-scan`. Security-pass survivors enqueue
even when market-quality fails (watching-only outcome). See
[ADR 046](adr/046-earlier-token-discovery.md) and
[collectors.md](architecture/collectors.md).

| Field | Default | Role |
|---|---|---|
| `enabled` | `true` | Master switch for the feed |
| `shadow_mode` | `false` | When true, write receipts/logs only (no queue mutate) |
| `chains` | `solana`, `ethereum`, `base`, `robinhood` | Registry chains with Gecko network mapping + research capability |
| `gecko_page` | `1` | GeckoTerminal new-pools page |
| `max_candidates_per_run` | `40` | Survivors kept after filter/sort |
| `max_enqueues_per_run` | `3` | Queue writes per list-scan |
| `max_enqueues_per_day` | `5` | Queue writes per UTC day |
| `min_pool_age_minutes` | `15` | Reject pools younger than this |
| `max_pool_age_hours` | `24` | Reject pools older than this |

### `retention` (schema 25)

Agent-workspace pruning on every completed run (`retainWorkspaceArtifacts`).
Never deletes under the host `archive/` tree.

| Field | Default | Role |
|---|---|---|
| `inbox_archive_days` | `30` | Age-prune `agent/inbox/<run-id>/` dirs |
| `chat_reports_days` | `30` | Age-prune `agent/reports/chat/*` |
| `alpha_ack_days` | `30` | Delete alpha-ack tombstones (`state/alpha-acks/` + legacy `state/research/alpha-ack-*`) older than this **and** already purged from `alpha-queue/`; the archived digest receipt stays the durable record (INV-Q2, ADR 044) |
| `narrative_dossier_days` | `120` | Delete `state/narratives/<slug>.md` dossiers untouched this long whose slug left `log.jsonl` (ADR 045) |
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

`tc wallets add-candidates <file>` merges operator-nominated **`candidate`**
wallets into existing `wallets.json` (`discoveredFrom: operator-nomination`).
Skips duplicates and hard-excluded records; archives a receipt under
`archive/wallet-candidates/`. Supports `--dry-run`. Entry schema matches the
`wallets` array in the operator seed file (`config/operator-seed.example.json`).
Seed at least one eligible wallet before wallet scan jobs can produce evidence.
Discovery also requires a tracking or watching watchlist entry. Discovery and
scan agents are evidence-only and cannot change wallet state, scores, cursors,
or lifecycle.

**Watchlist / sources:** schema accepted in the operator seed file; cold-start
application is not wired yet — only wallets are applied today.

## CLI surface (`trenchcoat`, alias `tc`)

| Command | Behaviour |
|---|---|
| `tc run <job>` | run one job (cron entry point); agent-mutating jobs refuse if the workspace writer lock is held (exit 3). `--no-broadcast` merges narrative memory and skips outbox, router, and research drain. Improvement jobs (`harness-improve`, `harness-meta-improve`, `incident-remediate`, `incident-remediate-weekly`) skip that lock (INV-S15 / ADR 027). Jobs include `list-scan`, `farcaster-scan`, scans/research/audit, wallets, plus harness/remediation |
| `tc config validate` | migrate+parse config in memory; no write |
| `tc config migrate --write` | persist schema migration to `~/.trenchcoat/config.json` |
| `tc watchlist remove <chain:token> --subject <symbol> --reason <text>` | host removal of ignored/revisit/dropped entries; reconciles `state/INDEX.md` |
| `tc probe farcaster` | Neynar feed probe + dynamic signer status + FC lifecycle/engagement summary |
| `tc auth farcaster --create --fname <name>` | programmatic bot account + signer (no app tap) |
| `tc auth farcaster --fid <n> --username <name> --mnemonic-stdin` | attach signer to existing FID (mobile approve, or OP ETH on custody for host `KeyGateway.add`) |
| `tc fc-source review [--dry-run] [--no-sync]` | FC follow-graph lifecycle review |
| `tc fc-source seed <path> [--dry-run]` | operator seed for FC managed follows (`config/fc-source-seed.example.json`) |
| `tc fc-source sync [--dry-run]` | apply desired follow graph with verification receipt |
| `tc fc-engagement status` / `dry-run <run-id>` | FC like engagement probe |
| `tc init [--seed <config>] [--operator-seed <file>]` | writes `~/.trenchcoat/config.json` from config seed via `migrateConfigToV29`; optional operator wallet seed |
| `tc wallets seed <file>` | operator-seed wallets into empty `state/wallets.json` |
| `tc wallets add-candidates <file> [--dry-run]` | merge operator-nominated candidates into existing wallet state |
| `tc auth twitter` | headful interactive re-auth (documented sandbox exception) |
| `tc auth fomo` | headful burner login for fomo.family |
| `tc auth pump [--headed]` | headful burner login for pump.fun; press Enter after login |
| `tc auth pump --status` | print cookie and localStorage counts; never print values |
| `tc auth pump --refresh [--headed]` | revisit pump.fun and write the session only when it still looks authenticated |
| `tc auth pump --import <storage-state.json>` | copy a local Playwright session file; never paste cookies into chat |
| `tc auth pump --import-cookie-header <file> [--import-local-storage <json>]` | build the session from a DevTools Cookie header plus localStorage |
| `tc pump-engagement status` / `dry-run <run-id>` | Pump like/follow probe |
| `tc auth twitter --create-managed-list` | one-time private managed source list; persists list id/url (ADR 004) |
| `tc probe twitter` | scrape all configured targets + lifecycle summary; no membership mutations |
| `tc source-list review [--dry-run] [--no-sync]` | deterministic promote/demote; dry-run skips state and X writes |
| `tc source-list sync` | sync desired managed membership to the persisted list id only |
| `tc harness propose --epoch <id>` | one hypothesis from a sealed scorecard (ADR 005; writes mining/keep/prior artifacts) |
| `tc harness run` / `tc run harness-improve` | scheduled policy pipeline → `activation_pending` (no agent activate / canary) |
| `tc harness prepare\|evaluate\|canary\|promote\|rollback\|status\|activate\|drain\|wait-idle` | confined worktree + holdout + drain-gated activate + bounded canary |
| `tc harness meta propose\|trial\|status\|promote\|reject` | shadow improver-config lane (ADR 039); promote is operator-only |
| `tc run harness-meta-improve` | scheduled shadow meta propose/trial step |
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
| `tc status` | shared health snapshot (lock/runs/jobs/findings/skips/queues/X/FC/router/deploy); Discord section when enabled; `--json` bounded payload; health warnings non-fatal |
| `tc remediations scan\|run\|status\|suggestions\|approve\|…` | incident remediation lane (ADR 017/025) |
| `tc broadcast feedback status\|ledger\|reconcile` | operator feedback counts, recent records, reaction re-read after listener downtime (ADR 043) |
| `tc broadcast feedback seal` | seal one dataset from the ledger and write the active preference set |
| `tc broadcast feedback candidate\|apply\|dismiss` | propose, write, or drop one bounded tuning candidate; apply needs a clean repo and never commits or deploys |

### `chat.discord` (schema 16+)

Private-guild research bot. Disabled by default. When enabled requires
`guild_id` and 1–20 unique `channel_ids`. Research has **no** per-user or
server daily caps and **no** per-user queue-depth cap — FIFO under `.worker.lock`
(one research at a time). Schema 16 removed `per_user_daily_cap`,
`server_daily_cap`, and `max_active_per_user` from `chat.discord` (tracking's
own `max_active_per_user` under `chat.discord.tracking` is unchanged).
`model` (default `composer-2.5-fast`, initial Discord research reply only;
material watch updates use host `composer-2.5` writer),
`max_watched_tokens` (500), `max_subscribers_per_token` (100). Watch
subscriptions last `watch_days` (30); monitor cadence `watch_scan_hours` (6);
proactive expiry asks use `watch_expiry_reply_window_days` (default 7).
State lives under `~/.trenchcoat/discord/` — see
[architecture/discord-research.md](architecture/discord-research.md) and
[architecture/discord-conversation.md](architecture/discord-conversation.md).

### `chat.discord.conversation` (schema 16+)

Opt-in channel conversation (`enabled` default false). Ask-mode sessions over
the main agent workspace; addressing gate + agent-triggered research with
synthesis. Defaults: `model` `composer-2.5`, `classifier_model`
`composer-2.5-fast`, `idle_timeout_minutes` 30, `turn_count_max` 40 (schema 19),
`context_messages` 10, `channel_ids` `[]` (all research channels),
`max_research_per_turn` 5.

Telegram operator chat (schema 19): `turn_count_max` 40, `max_prompt_chars`
12000 — rotate Cursor chat when turn count or prompt char estimate exceeds
these (idle timeout 30m unchanged).

### `chat.discord.wallet_signals` (schema 20)

Read-only Discord wallet-alert confluence (ADR 035). Default `enabled` false;
seed example enables with Solana + EVM channel IDs and `shadow_mode` true.
When enabled: Discord must be enabled, `guild_id` set, 1–20 unique
`channel_ids` **disjoint** from research `channel_ids`. Keys:
`scan_interval_minutes` 5, `max_message_age_hours` 6, `actor_dedupe_ttl_minutes`
15, `convergence` / `sell_pressure` (`enabled`, `window_minutes` 60,
`min_actors` 3), `max_enqueues_per_day` 3. See
[architecture/discord-wallet-signals.md](architecture/discord-wallet-signals.md).

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
