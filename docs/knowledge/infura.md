---
description: Provider knowledge — Infura + Robinhood public RPC for EVM wallet tracking.
scope: project
status: active
last_verified: 2026-07-21
source: https://docs.metamask.io/services/get-started/pricing/
---

# Infura / Robinhood EVM

- Ethereum and Base via Infura (`INFURA_API_KEY`); Robinhood via throttled
  official public RPC `https://rpc.mainnet.chain.robinhood.com` (no key)
- Finalized-block cursors; honour `removed` reorg logs
- Deterministic ERC-20 Transfer decoding without viem/ethers
  (`src/collectors/wallets/evm-provider.ts`)
- Robinhood uses a low token-bucket (default capacity 8, 0.15/s) and fail-closes
  on HTTP 429/5xx
- Archive raw payloads; fail closed on unfinalized or unpriceable actions
- `wallet-scan-evm` reports `Infura HTTP 401` when the key is rejected or
  expired — run status can still be `success`/`degraded` while every ethereum
  wallet errors and `actionsRecorded` stays 0. Fix the launchd/runtime
  `INFURA_API_KEY` (repo `.env` alone is not enough — run
  `ops/install-launchd.sh --sync-env`), then re-run `wallet-scan-evm`
  (Base/Robinhood paths are separate from ethereum Infura auth)

## Infura rate limit (Core / free)

Published (MetaMask pricing, credit model):

| Limit | Core free |
|-------|-----------|
| Daily credits | 3,000,000 |
| Throughput | **500 credits/second** |
| `eth_getLogs` | 255 credits |
| `eth_getBlockByNumber` | 80 credits |

Wallet scans are getLogs-heavy. Host pacing (`src/collectors/wallets/infura.ts`
via the shared `RateGate`):

- Serial mutex so concurrent callers cannot burst past the bucket
- Credit-weighted `take(cost)` per RPC method
- `minIntervalMs` ≈ `ceil(255 / 400 * 1000)` = **638ms** (80% of Core throughput
  as headroom) — forces a pause between Infura HTTP requests
- `gatedFetchWithRetry` on 429/5xx (bounded attempts, Retry-After)

Do not raise Infura gate capacity to allow multi-request bursts; that previously
produced `Infura HTTP 429` degraded `wallet-scan-evm` runs.
