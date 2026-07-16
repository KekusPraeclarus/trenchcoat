---
description: Chain registry - the single source of truth for supported chains, per-provider id mappings, address validation, and the flow for adding a new chain. Fail-closed for unsupported chains.
scope: module
status: draft
last_verified: 2026-07-16
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

All chain interaction in this system is **API-driven** — we never run a node or
read the blockchain over RPC. Adding a chain is therefore a registry entry plus
provider verification, not infrastructure.

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
| `robinhood` | evm | GoPlus (4663) — verify coverage at implementation | ETH |

RobinHood Chain (Arbitrum Orbit L2, mainnet chain id 4663, ETH gas) is
confirmed supported by DexScreener and GeckoTerminal; GoPlus coverage of id
4663 must be verified during implementation per step 2 of the flow below —
if GoPlus doesn't cover it yet, the entry ships scanner-less and the chain
stays **untrackable** (fail-closed) until coverage lands or an alternative
scanner is added. Extend the set freely via the flow below — a rotation into
a chain we don't cover is exactly the narrative-scan signal that should
trigger it.

## Fail-closed rule

A candidate whose chain has no registry entry, or whose registry entry has no
security scanner, **can never enter `watchlist.json` as `tracking`** and is never
sent to a research agent session. The resolver marks it
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
