---
description: On-chain runner→wallet discovery and tracked-wallet convergence trust model.
scope: project
status: accepted
date: 2026-07-21
supersedes: []
---

# ADR 020 — Runner wallet discovery and convergence

## Context

Watchlist-only early-buyer discovery cannot surface traders who repeatedly enter
fresh high-heat pools. Fomo profile addresses are not trading wallets. Transfer
recipients and mint balance deltas alone over-admit airdrops, pools, and
non-swap transfers.

## Decision

1. Wallet identity comes only from finalized on-chain verified buys on
   `solana`, `ethereum`, `base`, and `robinhood`.
2. A verified buy requires target-token acquisition plus native or allowlisted
   quote spend by the transaction signer/owner.
3. Fresh pools qualify via GeckoTerminal age + DexScreener identity/liquidity +
   closed 6h return/volume. Fail closed on unknown metrics.
4. Candidates require recurrence across ≥2 qualified runners in 30 days.
5. Tracked-wallet convergence (≥4 unique `tracking` wallets, 15m window) emits a
   host-rendered `wallet.convergence` alert labeled
   `UNVERIFIED WALLET CONVERGENCE` and independently enqueues research. It never
   mutates watchlist or wallet lifecycle.
6. Fomo never registers wallet candidates; legacy `discoveredFrom: "fomo"`
   records are quarantined.

## Consequences

- Infura/Helius/Robinhood RPC volume rises (receipts, block timestamps, tip
  cursors, `eth_getCode` / `getAccountInfo` for hard exclusions). Rate gates and
  credit costs must cover new methods.
- `state/wallet-runners.json` is host-owned and integrity-protected.
- Promotion remains lagged settled 72h scoring; discovery rank never shortcuts.

## Staged rollout gates

1. **Offline fixtures** — unit/property/integration/crash/red-team green;
   `pnpm test:all` passes.
2. **Live shadow discovery** — `runner_discovery.enabled=true`,
   `shadow_mode=true`; zero wallet / router / research-queue mutations.
3. **Candidate-write canary** — shadow off for candidate writes; alerts still
   blocked (`convergence.enabled=false` or canary `blockExternalEffects`).
   Per-chain floors before the next gate: Solana and Infura EVM each ≥20
   qualified runners and ≥50 verified buyer events; Robinhood independently
   ≥10 qualified runners and ≥25 verified buyer events.
4. **Convergence canary** — research enqueue on, alerts still blocked.
5. **Capped alerts** — enable `wallet.convergence` alerts only after zero false
   buyer classifications and zero duplicate effects in every enabled chain's
   canary receipts.

Any gate failure disables that chain's next gate without blocking healthy
chains and records the blocker in `ops/LIVE-E2E-BLOCKERS.md`.
