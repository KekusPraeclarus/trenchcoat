---
description: Operator configuration contract - env vars, the config file, seed formats, tunable thresholds, and the CLI surface. Everything the operator provides or invokes.
scope: project
status: draft
last_verified: 2026-07-16
read_when:
  - Implementing src/cli.ts or config loading, or setting up a deployment.
---

# Configuration and CLI

## Environment variables (secrets live here, never in files under the repo)

| Var | Used by | Purpose |
|---|---|---|
| `TRENCHCOAT_CURSOR_BIN` | orchestrator | optional path to `agent` binary |
| _(none — Cursor CLI login)_ | orchestrator, chat | `agent login` / `agent status` |
| `TRENCHCOAT_ROUTER_URL` / `TRENCHCOAT_ROUTER_TOKEN` | orchestrator | broadcast POST (stub until the router contract is pinned) |
| `TELEGRAM_BOT_TOKEN` | chat service | operator chat + outbound DMs |
| `TELEGRAM_OPERATOR_ID` | chat service | the allowlist (INV-B3) — single numeric user id |
| `GOPLUS_APP_KEY` / `GOPLUS_APP_SECRET` | collectors | security gate, EVM chains |
| `COINGECKO_DEMO_KEY` | collectors | trending endpoint |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | GramJS listener | MTProto fallback (session file under `~/.trenchcoat/telegram-session/`) |

Loaded from the process env (launchd plists set them from a mode-600 env file,
see ops/runbook.md). Nothing under `agent/` ever receives an env value (INV-I3).

## Config file — `~/.trenchcoat/config.json`

Non-secret operator inputs and tunables. Read at process start by the
orchestrator, collectors, and chat service. Versioned by a `schema` field.
Current schema is **4** (two `operator_list_urls`, managed list, source
lifecycle thresholds, FYP engagement caps). `loadConfig` migrates v1–v3 shapes
via `migrateConfigToV4`.

```json
{
  "schema": 4,
  "telegram_channels": [
    {
      "channel": "somechannel",
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
    "revisit_default_days": 7
  },
  "broadcast": { "daily_budget": 5, "urgent_ceiling": 10 },
  "source_safety": { "intent_classifier_daily_cap": 20 },
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
  "chat": { "idle_timeout_minutes": 30 },
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

Threshold semantics live in the doc owning each subsystem (security-gate.md,
audit-metrics.md, research-queue.md); the config only carries values. A config
change that alters semantics is a doc change first.

## Seed file — `trenchcoat init --seed <file>`

```json
{
  "watchlist": [
    { "chain": "solana", "token_address": "…", "thesis": "one line" }
  ],
  "sources": ["twitter:@handle", "telegram:channelname"]
}
```

Init resolves each watchlist entry through token-resolution (rejecting
unresolvable ones loudly), registers sources at neutral score, creates empty
`INDEX.md` / `narratives/` / `decisions.md`, and makes the initial state commit.
The first audit is skipped until decisions exist.

## CLI surface (`trenchcoat`, alias `tc`)

| Command | Behaviour |
|---|---|
| `tc run <job>` | run one job (the cron entry point); refuses if the workspace writer lock is held |
| `tc init --seed <file>` | cold start (above); refuses on a non-empty `agent/state/` |
| `tc auth twitter` | headful interactive re-auth (documented sandbox exception) |
| `tc auth twitter --create-managed-list` | one-time private managed source list; persists list id/url (ADR 004) |
| `tc probe twitter` | scrape all configured targets + lifecycle summary; no membership mutations |
| `tc source-list review [--dry-run] [--no-sync]` | deterministic promote/demote; dry-run skips state and X writes |
| `tc source-list sync` | sync desired managed membership to the persisted list id only |
| `tc x-engagement status` | like throttle window usage, follow/like counts |
| `tc x-engagement dry-run <run-id>` | show which bot choices would apply (rate-limit only); no X mutations |
| `tc research <chain:token_address>` | operator-priority enqueue + immediate research run |
| `tc undock <id>` / `tc confirm <id>` | terminal exoneration decisions (INV-S13) |
| `tc listen telegram` | the GramJS listener process (run under launchd, not by hand) |
| `tc status` | last run per job, queue depth, open ledger positions, lock state |

Exit codes: `0` success, `1` run never started (env/config problem,
`CursorAgentError`), `2` run failed mid-flight (inspect transcript), `3` lock
held / refused. The two failure kinds are never conflated (orchestrator.md).
