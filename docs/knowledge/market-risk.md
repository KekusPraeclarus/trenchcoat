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

## CoinGecko
- Trending coins/categories; monthly quota accounting; Demo key in host env

## Alternative.me
- Daily Fear & Greed; validate timestamp freshness

## GoPlus
- Token security auth + chain discovery; exact hard/caution mappings
- Quota failures fail closed for gate decisions

## RugCheck
- Solana scanner; capture raw + mapped flags; honour 429
