---
description: Trading pipeline data requirements - provider matrix per chain, bar cadence needs, scan integrity, and the open questions to resolve before building. NOT BUILT YET.
scope: project
status: planned
last_verified: 2026-07-29
---

# Data and providers

## Requirements (what the pipeline needs that trenchcoat doesn't already do)

| Need | Why | Existing base |
|---|---|---|
| **1m/5m closed bars, low latency, per canonical pair** | fill simulation + adverse ordering (a 5m bar can hit entry/target/stop together) | `createLiveIdentityBarProvider` chain: DexScreener (pool meta) → GeckoTerminal (5m OHLCV) → SolanaTracker → Birdeye (`src/orchestrator/market-bars.ts`) — 5m exists; **1m availability/depth per provider unverified** |
| **Ranked market scan (~150/day per chain)** | candidate universe | DexScreener used for pool metadata/search today; a ranked top-N scan endpoint (or GeckoTerminal/Birdeye equivalent) needs evaluation — ranking provider and bar provider may differ |
| **Liquidity / volume / txn / pair-age / boost fields per candidate** | chart-quality gate + fill realism caps | partially collected today for watchlist tokens; needs to run across the scan universe |
| **CoinGecko Trending** | sentiment bucket | CoinGecko trending collector exists (`src/collectors/market/`) |
| **Fomo Trending (aggregate)** | sentiment bucket | Fomo web client already fetches trending (`src/collectors/fomo/web-client.ts`); reuse within the navigation budget — aggregate surface only, no account-level data |
| **Promoted wallet / Fomo trader cohorts** | Smart Money Context | `wallets.json` lifecycle + `fomo-trader-scores.json` promotions exist; need a read-only projection/snapshot API, lagged per INV-S14 discipline |
| **Gauge basket data** | sentiment bucket | main watchlist `tracking` tokens already collected every `watchlist-scan` |
| **Narrative outputs** | sentiment bucket | `state/narratives/log.jsonl` host-owned records exist |

All new fetches go through the shared rate-limit gate (INV-R1) — budgets for
a several-times-daily 25-token scan × bars per candidate need to be sized
against published limits (GeckoTerminal 25/min is the tight one; DexScreener
200/min; SolanaTracker ~3/s; Birdeye ~1/s).

## Chain rollout

| Chain | Phase | Notes |
|---|---|---|
| Solana | v1 | richest provider coverage today (GeckoTerminal + SolanaTracker + Birdeye fallbacks) |
| Base | v2 | verify 1m/5m OHLCV depth + ranked-scan coverage; chain-calibrated lifecycle/liquidity thresholds |
| Robinhood | v2 | first-class from the start: chain-aware bars, slippage, cohort context, scorecard slices — never a Solana fallback path |
| Others | later | follow rotations; additive via the existing chain registry (chains.md fail-closed rule applies) |

## Scan integrity (non-negotiable)

Every scan batch archives: exact query + filters + ranking + pagination,
raw response hash, timestamp, and the resulting candidate list. Candidates
cannot be added to a batch retroactively (draft INV-T5). This is what makes
"the system found it before the move" claims auditable.

## Open questions to resolve before building

1. **1m OHLCV** — which providers offer it per chain, at what depth and rate
   cost? If 1m is unavailable for a chain, is trade-level/event data a viable
   substitute for fill ordering, or does that chain run 5m-with-adverse-
   ordering only?
2. **Ranked scan endpoint** — DexScreener vs GeckoTerminal vs Birdeye for the
   top-N universe: coverage, ranking transparency, rate cost, boost-flag
   availability. (The article's flow was manual Dexscreener browsing; we need
   the API equivalent.)
3. **Bar archive breadth** — how much OHLCV to retain for scanned-but-rejected
   candidates (they are the counterfactuals for gate/scoreboard review);
   storage growth vs review value.
4. **Cohort projection shape** — file snapshot vs computed-at-scan projection
   for Smart Money Context; how tier + promotion timestamps are exposed
   without leaking mutable score internals.
5. **Executor stack (dollar phase)** — Jupiter API vs alternatives per chain;
   quote-at-plan-time vs quote-at-fill-time for the slippage model; what the
   $1-phase fill telemetry needs to capture.
6. **Sentiment regime definition** — the exact frozen fields and the initial
   regime taxonomy (risk-on/off × breadth × chain-rotation state); keep the
   first version small and measurable.
