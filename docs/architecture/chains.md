---
description: Chain registry - the single source of truth for supported chains, per-provider id mappings, address validation, and the flow for adding a new chain. Fail-closed for unsupported chains.
scope: module
status: active
last_verified: 2026-07-20
read_when:
  - Adding or modifying chain support, or editing any code that passes a chain identifier to an upstream API.
---

# Chain registry

## Purpose

Every upstream provider names chains differently (GeckoTerminal `network`,
DexScreener `chainId`, GoPlus numeric `chain_id`) and token addresses have
chain-specific formats. The registry is the one typed table (`src/lib/chains.ts`)
that maps our canonical chain slug to every provider's identifier, so no client
ever hardcodes a chain string.

All chain interaction for **token** market data is **API-driven** (GeckoTerminal /
DexScreener / scanners). Wallet tracking is the exception: it uses finalized
read-only RPC (Helius / Infura / Robinhood public) per `walletTracking` in
`src/lib/chains.ts` and [smart-wallets.md](smart-wallets.md). Adding a chain for
token tracking is still a registry entry plus provider verification; enabling
wallet tracking additionally requires a provider kickoff and cursored scan path.

## Registry entry shape

```json
{
  "slug": "base",
  "display": "Base",
  "family": "evm",
  "geckoterminal_network": "base",
  "dexscreener_chain_id": "base",
  "security_scanner": { "kind": "goplus", "chain_id": "8453" },
  "native_benchmark": "ethereum:eth",
  "address_format": "evm"
}
```

- `family` — `evm | solana | other`; drives address validation and scanner choice
- `security_scanner` — **mandatory**. `goplus` (with its numeric `chain_id`),
  `rugcheck` (Solana), or absent — and absent means the chain is *listed but not
  trackable* (see fail-closed rule)
- `native_benchmark` — the chain-native asset audits compute excess returns
  against (see audit-metrics.md)
- `address_format` — `evm` (0x + 40 hex, checksummable) or `base58-32` (Solana
  mint). Validation is applied to every address before it is used in an API
  path or matched for attribution

## Initial supported set (v1)

| Slug | Family | Scanner | Benchmark |
|---|---|---|---|
| `solana` | solana | RugCheck | SOL |
| `ethereum` | evm | GoPlus (1) | ETH |
| `base` | evm | GoPlus (8453) | ETH |
| `bsc` | evm | GoPlus (56) | BNB |
| `robinhood` | evm | GoPlus (4663) | ETH |
| `plasma` | evm | GoPlus (9745) | XPL |
| `hyperliquid` | evm | *(none — GoPlus gap)* | HYPE |

RobinHood Chain (Arbitrum Orbit L2, mainnet chain id 4663, ETH gas) is
confirmed supported by DexScreener and GeckoTerminal. Wallet tracking uses the
throttled official public RPC; GoPlus id 4663 is registered — verify live
coverage at preflight and fail closed if absent.

Plasma (mainnet chain id 9745, XPL gas) is on DexScreener/Gecko as `plasma` and
GoPlus as `9745` — fully trackable.

Hyperliquid maps our slug `hyperliquid` onto DexScreener/Gecko **`hyperevm`**
(HyperEVM AMM pools; HyperCore spot uses a separate `hyperliquid` provider id
with non-EVM address shapes and is out of scope). GoPlus does not cover chain
999 yet, so the entry ships **without** `security_scanner`: research and
Discord member-watch still resolve, but main-agent `tracking` stays blocked
(INV-S9 / `isTrackableChain`).

## Fail-closed rule

A candidate whose chain has no registry entry **can never enter
`watchlist.json` as `tracking`** and is never sent to a research agent session.
A registry entry **without** a security scanner may still be researched
(Discord / operator) and Discord-watched, but `isTrackableChain` is false so
main-agent track / promote stays blocked. The resolver marks unknown slugs
`rejected: unsupported-chain` in the research queue, and the decision log records
the rejection so audits can measure what unsupported chains are costing us
(the trigger to add them). Covered by INV-S9.

## Adding a new chain

Purely additive, no blockchain access required:

1. Add the registry entry; verify each provider id against live API responses
   (GeckoTerminal networks list, a known DexScreener pair, a known-good scanner
   call for a major token on that chain)
2. Confirm scanner coverage: run the scanner against one known-good and one
   known-rugged token on the chain; if no scanner covers the chain, stop —
   the entry ships without `security_scanner` and stays untrackable
3. Add the address-format validator if the family is new
4. Unit tests: registry completeness (every entry has scanner or is flagged),
   address validation accept/reject vectors
5. Update the table above and `security-gate.md` in the same change

## Consumers

- `src/lib/resolve.ts` — canonical identity resolution (token-resolution.md)
- `src/collectors/market/` — every GeckoTerminal/DexScreener call
- `src/collectors/market/security.ts` — scanner routing (security-gate.md)
- `src/orchestrator/audit.ts` — benchmark selection for excess returns
