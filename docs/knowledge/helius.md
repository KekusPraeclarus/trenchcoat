---
description: Provider knowledge — Helius Solana finalized RPC for wallet tracking.
scope: project
status: active
last_verified: 2026-07-21
---

# Helius

- Use standard RPC only; finalized commitment as truth
- Do not use deprecated Enhanced Transactions
- Archive raw responses; cursor by signature (`before`)
- Early buyers: `src/collectors/wallets/helius-provider.ts` walks mint
  signatures and positive token-balance deltas
- Wallet scan: same primitives for known wallet addresses
- Env: `HELIUS_API_KEY`
- No signing / sendTransaction paths
- **Fomo never feeds wallet tracking.** Leaderboard `address` / `evmAddress`
  are profile ids, not trading wallets (`getAccountInfo` often null). Do not
  nominate them into `wallets.json`. Fomo informs signals + optional X-source
  nomination only (`fomo-trader-sync` / `fomo-signal-scan`).
- Wallet-scan cursor uses Helius `before` for backfill and tip/`until`
  semantics for forward scans (`wallet-scan-tip` cursors)
- Verified buys require target-mint gain **and** native/allowlisted quote
  spend by the signer (`extractSolanaVerifiedBuysFromTransaction`)
- Verified sells require target-mint decrease **and** quote gain
  (`extractSolanaVerifiedSellsFromTransaction`) for FIFO copy-trade settlement
- Hard exclusions call `getAccountInfo` (executable → `program`); incomplete
  evidence holds the sighting instead of excluding
- **Fomo never feeds wallet tracking.** Leaderboard `address` / `evmAddress`
  are profile ids, not trading wallets (`getAccountInfo` often null). Do not
  nominate them into `wallets.json`. Fomo feed trades score via
  `fomo-trader-scores.json` only (`fomo-trader-sync` / `fomo-signal-scan`, ADR 032).
