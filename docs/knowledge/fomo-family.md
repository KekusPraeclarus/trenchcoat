---
description: Fomo.family authenticated SPA scrape used as the social-graph bridge for trader nomination and signals. Burner-only; nomination/evidence only.
scope: knowledge
status: active
last_verified: 2026-08-26
source: https://fomo.family
---

# Fomo.family (web bridge)

[fomo.family](https://fomo.family) is scraped via Playwright with a host-only
burner session (`~/.trenchcoat/fomo-profile/`). There is no API key. Read-only
HTTP methods plus an allowlisted set of SPA read POSTs (`/v2/users` bootstrap,
`/proxy/*` lists). Host follow uses a separate context with `mutationMode`
for follow/unfollow paths only. Trades/transfers/profile edits stay blocked.

## Binding rules

- Host-only burner profile (INV-I3). Never under `agent/`, never in fixtures
- Navigation budget + request policy gate every request (INV-R1)
- Snapshots are `trust: untrusted-external` (INV-P1)
- Research / X-nomination mutations only when FAFO gates pass and
  `shadow_mode=false`. Fomo never writes `wallets.json`. Health reports FOMO
  as a parallel-only section — it never clears FC corroboration or legacy
  research/wallet warnings

## Jobs

- `fomo-trader-sync` — leaderboard handles for FOMO-platform follows and
  optional X nominations when the profile has an explicit X link (never wallet
  candidates; Fomo profile `address`/`evmAddress` are not trading
  wallets). Host-only; shares the agent workspace lock with `source-list-review`,
  `list-scan`, telegram-alpha (via channels), and x-scan. A hung Playwright X
  list sync can starve trader-sync for hours (`workspace lock held` in
  `/tmp/trenchcoat.fomo-trader-sync.*.log`). If the holder is idle chromium with
  only `blocked non-list mutation` logs past ~10m, operator-fail the run and
  re-kick: `tc run fail <runId> --reason '…'` then
  `run-with-lock-retry fomo-trader-sync -- --skip-agent`. Not listed in
  `KEY_HEALTH_JOBS` — verify via archive run / `fomo-leaderboard` inbox, not
  `tc status` job lines.
  - `fomo-signal-scan` — feed / alerts / derived convergence & pressure;
  trending/hot may enqueue research when gates + config allow. Native/wrap gas
  mints and reserved chain symbols never burn the daily enqueue cap
  (`max_enqueues_per_day`, default 3). Feed cards are `multi_user_buy|sell`
  shapes: expand `body.topTraders` with `networkId` (or solana base58 inference)
  into per-handle trade events. Accepted feed buy/sell events archive to
  `archive/outcomes/fomo-trade-*.json` and settle FIFO into
  `state/fomo-trader-scores.json` (never `wallets.json`; INV-S19 / ADR 032).
  Profile `address`/`evmAddress` remain banned from wallet nomination.
  **Score eligibility:** only FIFO-matched buy→sell pairs with two distinct
  eligible finalized five-minute OHLCV observations receive `settlementStatus:
  priced` and enter `fomo-trader-scores.json`. Sell-only rows (no prior buy for
  that handle+token), same-candle holds, and other non-priceable matches are
  annotated `sell-only` or `non-priceable` and never invent a loss or score.
  Provider outages remain `provider-pending` and are retried on later
  `outcomes-settle` runs. Solana bar pricing uses GeckoTerminal with
  SolanaTracker/Birdeye fallback when configured.
- `fomo-x-source-review` — classify nominated X accounts from X posts only.
  Host merge uses sealed X-post CAs for the shiller entry bar (10 calls / 5
  tokens). FOMO buys do not count and are not scraped on this job. Sells,
  quote mints, and profile wallets stay unused. Only X-post CAs enter the
  call log. FOMO traders score on FIFO `fomo-trader-scores.json`. Narrative
  and both still need `narrative_source_probation.enabled` to register.
- `fomo-narrative-source-scan` — live (<=6h) posts from probation narrative X
  sources (never reuses historical review posts)
- `narrative-source-review` — promote/demote narrative sources; capped follow
  via existing X engagement executor
- Research dossiers may attach live `fomo-context` from the observation cache
  when `fomo.enabled`
- `narrative-scan` copies sealed fomo narrative posts into
  `narrative-social-fomo-x` (excludes `purpose=historical-source-evaluation`)

## Live API (2026-08-26)

The leaderboard path is still `/v2/leaderboard/7d`.
The envelope is `{ responseObject: { leaderboard: array } }`.
The `twitter` field is a string, an object, or null.
The mapper keeps the row when `userHandle` is present.
It reads an X handle from a `twitter` object when that object has one.
It does not treat `address` or `evmAddress` as wallets.
The live feed path is `/feed/token`.
The old `/feed/tradingActivity` path stays as a fallback.
The capture does not take `/feed/token/thesis`.

## Probe

```bash
pnpm probe:fomo discover --run-id probe-YYYY-MM-DD
pnpm probe:fomo status --run-id probe-YYYY-MM-DD
pnpm probe:fomo sanitize --run-id probe-YYYY-MM-DD
pnpm tsx scripts/smoke-fomo-live.ts
pnpm fomo:install-gates ops/fafo-fomo/gates.operator-override-2026-07-19.json
```

`probe:fomo` has no `evaluate` command yet. Live smoke confirms parsers against
the authenticated SPA; install an operator override or FAFO gates JSON after.

Details: [ops/fafo-fomo/REPORT.md](../../ops/fafo-fomo/REPORT.md).
