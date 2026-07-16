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
| `CURSOR_API_KEY` | orchestrator, chat | agent sessions |
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

```json
{
  "schema": 1,
  "telegram_channels": [
    { "channel": "somechannel", "mode": "preview" },
    { "channel": "privatepreview", "mode": "gramjs" }
  ],
  "twitter": { "curated_list_url": "…", "max_pages_per_run": 5 },
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
  "chat": { "idle_timeout_minutes": 30 }
}
```

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
| `tc research <chain:token_address>` | operator-priority enqueue + immediate research run |
| `tc undock <id>` / `tc confirm <id>` | terminal exoneration decisions (INV-S13) |
| `tc listen telegram` | the GramJS listener process (run under launchd, not by hand) |
| `tc status` | last run per job, queue depth, open ledger positions, lock state |

Exit codes: `0` success, `1` run never started (env/config problem,
`CursorAgentError`), `2` run failed mid-flight (inspect transcript), `3` lock
held / refused. The two failure kinds are never conflated (orchestrator.md).
