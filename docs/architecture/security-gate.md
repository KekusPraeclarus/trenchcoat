---
description: Token security gate - exact GoPlus/RugCheck field-to-flag mapping per chain family, hard-fail vs caution semantics, the market-quality preflight, and fail-closed behaviour for scanner outages and unsupported chains.
scope: module
status: draft
last_verified: 2026-07-16
read_when:
  - Editing src/collectors/market/security.ts or market-quality checks, or changing what blocks a track verdict.
---

# Security gate

## Purpose

Deterministic, pre-LLM rejection of rugs and untradeable tokens. Two layers:
the **scanner gate** (contract-level risk via GoPlus/RugCheck) and the
**market-quality preflight** (tradeability via DexScreener data). Both produce
typed results the orchestrator consumes — INV-S9 keys off these, and the
rug-shill dock (orchestrator.md) triggers **only** off the typed scanner
response, never off text.

## Scanner routing

The chain registry (chains.md) selects the scanner. No registry entry or no
scanner → fail-closed, candidate rejected as `unsupported-chain`.

## Hard-fail mapping (blocks track, triggers dock attribution)

The scanner response is mapped to a boolean `hard_fail` plus typed `flags` by
pure functions in `src/collectors/market/security.ts`:

**GoPlus (EVM)** — `hard_fail` iff any of:

| Response field | Condition |
|---|---|
| `is_honeypot` | `"1"` |
| `cannot_sell_all` | `"1"` |
| `is_mintable` | `"1"` |
| `owner_change_balance` | `"1"` |
| `selfdestruct` | `"1"` |
| `sell_tax` | ≥ 0.20 |
| LP lock | locked-or-burned LP fraction < 0.80 (from `lp_holders` lock flags + burn addresses) |

**RugCheck (Solana)** — `hard_fail` iff any of:

| Report field | Condition |
|---|---|
| mint authority | present/active |
| freeze authority | present/active |
| LP lock | locked-or-burned LP fraction < 0.80 |
| top-10 holder concentration | > 0.50 of supply (excluding pools/burn) |

Threshold values are config-tunable (CONFIG.md); the field mapping is code and
changes here first.

## Caution flags (surfaced to the agent, don't block)

Proxy contract, buy/sell tax 0.05–0.20, trading cooldown, anti-whale limits,
blacklist capability, unverified source, holder concentration 0.30–0.50.
Written into the research snapshot as `security.flags` — the agent weighs them
in its verdict and must cite them when tracking anyway.

## Scanner failure semantics (fail-closed)

- Scanner HTTP error / timeout / unparseable response → `status: "pending"`,
  bounded retries via the rate gate; still failing → the candidate stays
  undequeued in the research queue (never "pass by default")
- A `hard_fail` can never be produced by a fallback or a parse error —
  the dock's severity demands the trigger be a genuine typed scanner verdict
  (INV-S12). Parse failure blocks the candidate but docks nobody.

## Market-quality preflight (tradeability)

Same run, after the scanner passes — pure functions over DexScreener pair data:

| Check | Default floor/bound (config) |
|---|---|
| Pool liquidity | ≥ $30k |
| 24h transactions | ≥ 150 |
| Unique-ish activity | buys and sells both ≥ 25% of txns (wash/one-sided filter) |
| FDV / liquidity ratio | ≤ 100 |
| Liquidity delta since last snapshot | > −30% |

Failing the preflight marks the entry `market_quality: fail` — treated like a
soft gate: no `track` allowed this run (post-run check enforces), but the
candidate may re-enter via revisit rather than terminal rejection, since thin
early pools can mature.

## Where it runs

- **Research dequeue** — always, both layers, freshest data
- **New-pool feed (list-scan)** — scanner + liquidity floor as the stream
  filter (collectors.md); survivors carry their gate result into the snapshot
- **Watchlist-scan** — liquidity-delta re-check on tracked tokens; a tracked
  token that newly hard-fails (e.g. LP unlock) raises an urgent-eligible flag
  in the snapshot

## Audit metrics

Gate catch rate (rejected candidates that later rugged — from the discovery
log), false-block rate (rejected candidates that performed), loss rate of
tracks that passed the scanner but carried caution flags vs clean passes.
