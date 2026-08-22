---
title: "032 — Peak shill returns and copy-trade wallet/Fomo P&L"
status: accepted
date: 2026-07-23
last_verified: 2026-08-18
---

# ADR 032: Peak shill returns and copy-trade wallet/Fomo P&L

## Context

Fixed-horizon excess returns (notably 72h) scored shill sources and on-chain
wallets as if every mention or buy were a hold-to-horizon trade. That misread
both domains: shill quality is about how far price ran from the call, and
wallet quality is about realized copy-trade P&L when the tracked wallet exits.
Fomo profile addresses remain non-trading (INV-S19); feed buy/sell events are
the only Fomo copy-trade evidence.

Bot paper ledger entry finalisation (ADR 031) stays separate — shared bar
pricing only. Do not conflate `ledger.json` paper P&L with source/wallet
quality scores.

## Decision

1. **Shill / source-call headline** = peak% from entry:
   `(peakHigh − entryOpen) / entryOpen`. Settle when no new high for **6h**;
   otherwise `provider-pending`. Force-complete after **14d** at peak-so-far
   so coverage cannot stall. Hit threshold remains ≥ **+20%**. Horizon
   observations may still be written as diagnostics; source-list scoring reads
   peak (`observationSpecVersion` 2, archive key `horizonHours: 1` /
   `peakReturn`).

2. **On-chain wallets** = FIFO buy→sell copy-trade. Scans archive verified
   `swap-buy` and `swap-sell` (token decrease + quote gain). Settler matches
   lots on `(walletId, chain, token)`; partial sells OK; `realizedReturn =
   exitOpen/entryOpen − 1` from market bars at event times. Open buys without
   a sell are **not** settled (no invented horizon P&L).
   `aggregateWalletPerformance` scores settled `realizedReturn` only.
   Legacy archives omit `side` (treat as buy).

3. **Fomo traders** = same FIFO maths on **feed** buy/sell events archived
   from `fomo-signal-scan` (`archive/outcomes/fomo-trade-*.json`), keyed by
   `(handle, chain, token)`. Scores live in `state/fomo-trader-scores.json`.
   Profile `address` / `evmAddress` still never enter `wallets.json`.
   Settlement annotates each archived leg with `settlementStatus`:
   `sell-only` (no open buy), `non-priceable` (matched but same-candle or
   otherwise unpriceable on five-minute bars), `provider-pending` (retryable
   bar outage), or `priced` (distinct eligible bars). Only `priced` closes
   contribute to trader scores — never invented losses.

4. **`outcomes-settle`** runs: horizon diagnostics → source peaks → wallet
   horizon diagnostics → wallet copy-trade → Fomo copy-trade → pump calls
   → ledger settle.

## Alternatives considered

- **Keep 72h as headline for sources** — rejected; peak better matches shill
  intent and avoids holding-period fiction.
- **Mark open wallet buys at a fixed horizon** — rejected; invents P&L the
  tracked wallet never realized and starves true exits.
- **Put Fomo traders into `wallets.json` via profile addresses** — rejected;
  INV-S19 quarantine (profile ≠ trading wallet). Feed events are the signal.
- **Reuse paper ledger for wallet quality** — rejected; separate stores,
  different settle rules (ADR 031 vs this ADR).

## Consequences

- Source and wallet promotion gates move with the new metrics; historical 72h
  fields remain readable as fallbacks for sources during transition.
- Wallet scores stay thin until sells appear in scan archives — expect
  `tracking=0` until copy-trade closes accumulate.
- Shared OHLCV `high` on `PriceBar` is required for peak settlement; long
  peak lookbacks may fetch more Gecko OHLCV pages (≥168h → 24 pages).

## Follow-ups

- After deploy: `tc run outcomes-settle` then `tc run wallet-review` (large
  buy backlog + new sell detection).
- Optional idle/rug handling for buys that never sell.

## See also

- INV-S19, INV-S21; ADR 002 scoring inputs; [smart-wallets.md](../architecture/smart-wallets.md);
  [source-lifecycle.md](../architecture/source-lifecycle.md);
  [audit-metrics.md](../architecture/audit-metrics.md)
