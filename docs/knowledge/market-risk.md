---
description: Provider knowledge — GeckoTerminal, DexScreener, CoinGecko, Alternative.me, GoPlus, RugCheck.
scope: project
status: active
---

# Market and risk providers

## GeckoTerminal
- OHLCV source of truth; closed candles only; pagination + new pools
- Budget below 25/min shared gate

## DexScreener
- Pair/search/boost only — never OHLCV
- Budget below 200/min
- Search responses can include junk rows (empty or multi-KB concatenated
  symbols/names). `parseDexScreenerPairs` skips malformed pairs rather than
  failing the whole search

## CoinGecko
- Trending coins/categories; monthly quota accounting; Demo key in host env
- Join paths as `new URL("search/trending", root + "/")` — a leading `/` drops
  `/api/v3`, CoinGecko 301s, and `gatedFetch` (`redirect: "error"`) surfaces as
  TypeError `fetch failed`
- Category `id` is numeric; prefer `slug` as the stable string id. Change fields
  may be `market_cap_1h_change` rather than `market_cap_change_24h`
- Narrative-scan market attention is `fetchMarketAttentionForNarrative` in
  `providers.ts` + `narrative-collect.ts` — **not** `aggregate.ts` or
  `market-bars.ts` (those are OHLCV/settlement only)
- Uses `gatedFetchWithRetry` (≤3 attempts, 429/5xx/timeout) then falls back to
  DexScreener boosts + GeckoTerminal new pools. Fallback attention is **not**
  category rotation — runs stay `marketBlind` until CG categories land
- Unified rate gate: 25/min, 10k/month (do not open a second CoinGecko gate)

## Alternative.me
- Daily Fear & Greed; validate timestamp freshness

## GoPlus
- Token security auth + chain discovery; exact hard/caution mappings in
  security-gate.md (ADR 011: mintable/mint-authority are caution-only;
  host still blocks mintable memecoins after model classification)
- Quota failures fail closed for gate decisions

## RugCheck
- Solana scanner; capture raw + mapped flags; honour 429
- Mint authority is caution-only (same ADR 011 rule as GoPlus mintable)
