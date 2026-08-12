---
description: Token security gate - exact GoPlus/RugCheck field-to-flag mapping per chain family, hard-fail vs caution semantics, the market-quality preflight, and fail-closed behaviour for scanner outages and unsupported chains.
scope: module
status: active
last_verified: 2026-08-12
read_when:
  - Editing src/collectors/market/security.ts, src/orchestrator/gate-evidence.ts, market-quality-evidence, or market-quality checks, or changing what blocks a track verdict.
---

# Security gate

## Purpose

Deterministic, pre-LLM rejection of rugs and untradeable tokens. Two layers:
the **scanner gate** (contract-level risk via GoPlus/RugCheck) and the
**market-quality preflight** (tradeability via DexScreener data). Both produce
typed results the orchestrator consumes — INV-S9 keys off these, and the
rug-shill dock (orchestrator.md) triggers **only** off the typed scanner
response, never off text.

Binding decision for mint caution + memecoin block: [ADR 011](../adr/011-contextual-mint-security.md).

## Scanner routing

The chain registry (chains.md) selects the scanner. No registry entry →
fail-closed as `unsupported-chain`. Registry entry without a scanner → security
status `unsupported-chain` (research may still run; main track blocked).
Automated Discord chain integration may deploy research-only manifests when
scanner coverage is absent (ADR 016); wallet tracking stays off.

## Thresholds from config

`securityThresholdsFromConfig` (`src/lib/config.ts`) maps
`config.gate_thresholds` into the scanner/preflight structs. Both scheduled
runs and operator research call this — no hardcoded threshold forks.

## Hard-fail mapping (blocks track, triggers dock attribution)

The scanner response is mapped to a boolean `hard_fail` plus typed `flags` by
pure functions in `src/collectors/market/security.ts`:

**GoPlus (EVM)** — `hard_fail` iff any of:

| Response field | Condition |
|---|---|
| `is_honeypot` | `"1"` |
| `cannot_sell_all` | `"1"` |
| `owner_change_balance` | `"1"` |
| `selfdestruct` | `"1"` |
| `sell_tax` | ≥ `sell_tax_max` (default 0.20) |

**RugCheck (Solana)** — `hard_fail` iff any of:

| Report field | Condition |
|---|---|
| freeze authority | present/active |
| top-10 holder concentration | > `holder_top10_max` (default 0.50 of supply, excluding pools/burn) |

Threshold values are config-tunable (CONFIG.md); the field mapping is code and
changes here first.

## Caution flags (surfaced to the agent, don't hard-fail alone)

**`mintable` / `mint-authority`** — GoPlus `is_mintable` or RugCheck mint
authority present. Surfaced as caution; **never** sets scanner `hardFail`
alone. The research model must set `projectClassification` and, when mint is
active, `mintAssessment`. Host validation then applies a **contextual**
block: `track` is rejected when mint is active **and** classification is
`memecoin`, or when classification is missing. Justified utility /
infrastructure mints (e.g. capped emissions + PoW rewards) may track.
Contextual rejection does **not** trigger rug-dock (INV-S12 stays
scanner-hard-fail only).

**`low-lp-lock`** — locked-or-burned LP fraction below `lp_locked_min`
(default 0.80; GoPlus `lp_holders` lock/burn flags, RugCheck `lpLockedPct`).
Still flagged and written into evidence; **never** sets `hardFail` alone.

Also caution: proxy contract, buy/sell tax 0.05–0.20 (buy-tax path), trading
cooldown, anti-whale limits, blacklist capability, unverified source. Written
into the research snapshot as `security.flags` — the agent weighs them in its
verdict and must cite them when tracking anyway.

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

Failing the preflight marks the entry `market_quality: fail`. Host proposal
apply auto-downgrades proposed `tracking` to `watching` (INV-S9): security must
still pass, no ledger position opens, and research broadcasts for that subject
fail with `market-quality-watching`. Missing market-quality evidence blocks
both `tracking` and `watching`. New-pools enqueue still accepts MQ-fail
survivors so research can run; the watching-only outcome holds after verdict
(ADR 046). Thin early pools may later pass MQ on revisit.

## Where it runs

- **Research dequeue** — always, both layers, freshest data
- **Confirmed operator research** — same path as scheduled: thresholds via
  `securityThresholdsFromConfig`, proposal gating via
  `resolveGateArchiveThenLive` + `archivedProvenanceAllowlist` (INV-S6/S9). A
  scanner hard fail remains binding for track/broadcast eligibility and leaves the
  queue entry rejected, but does not abort evidence collection or the requested
  report; the report must surface the typed flags. Researching a risky token is
  not permission to track it. Active mint without memecoin classification may
  still track when the model justifies it
- **New-pool feed (list-scan)** — scanner hard-fail rejects; MQ runs and is
  recorded on survivors, but MQ fail does not drop the candidate
  (collectors.md, ADR 046)
- **Watchlist-scan** — liquidity-delta re-check on tracked tokens; a tracked
  token that newly hard-fails raises an urgent-eligible flag in the snapshot
  *(collection currently unavailable — see collectors.md routing)*
- **Host proposal gating** — `resolveGateArchiveThenLive` prefers the same-run
  archived security dossier; if absent and not dry-collect, allowlisted live
  GoPlus/RugCheck refetch writes a gate receipt under
  `archive/runs/<run-id>/gate-receipts/` (failures stay pending — never invent
  a pass). Market-quality uses archive-only
  `resolveMarketQualityFromArchive` (inbox `market-quality` dossier; no live
  MQ refetch) and writes a market-quality receipt. After a scanner `pass`,
  `applyDecisionProposals` downgrades MQ-fail tracks to `watching` and applies
  `mintTrackBlockReason` for active mint + memecoin / missing classification
  on final `tracking` only
- **Discord member-watch** — `evaluateDiscordWatchSubscribe` (hard-fail only);
  main-agent promote still uses `evaluateResearchSubscribe` + mint rule
  (discord-research.md)

## Audit metrics

Gate catch rate (rejected candidates that later rugged — from the discovery
log), false-block rate (rejected candidates that performed), loss rate of
tracks that passed the scanner but carried caution flags vs clean passes.
