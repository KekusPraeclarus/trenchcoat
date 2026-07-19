---
description: Provider knowledge — Infura + Robinhood public RPC for EVM wallet tracking.
scope: project
status: active
last_verified: 2026-07-19
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
