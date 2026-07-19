---
description: Provider knowledge — Helius Solana finalized RPC for wallet tracking.
scope: project
status: active
last_verified: 2026-07-19
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
