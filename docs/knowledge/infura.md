---
description: Provider knowledge — Infura EVM HTTP/WSS wallet tracking.
scope: project
status: active
---

# Infura

- Ethereum and Base only for wallet tracking unless kickoff proves otherwise
- HTTP + WSS; tightly filtered logs; reconnect with finalized-block cursor
- Honour `removed` reorg logs; reconcile EOA nonces and receipts
- Deterministic ERC-20 Transfer decoding without viem/ethers
- Archive raw payloads; fail closed on unfinalized or unpriceable actions
