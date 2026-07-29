---
description: Trading pipeline design - system boundaries, data flow, candidate universe, sentiment bucket, Smart Money Context contract, chain model, proposed state/jobs, and invariant candidates. NOT BUILT YET.
scope: project
status: planned
last_verified: 2026-07-29
---

# Trading pipeline — design

## Purpose

Grade and tune **our own trading decisions** end-to-end, with enough rigour
that the same policy objects can later drive real capital. Distinct from the
wallet / Fomo copy-trade paper books, which grade **other traders** and must
keep doing so untouched.

Method: **live paper trading, not backtesting.** Every scan freezes the
eligible universe, features, regime, and policy version before any subsequent
price action exists, so hindsight bias is structurally impossible. Live paper
does not remove all bias by itself — it still requires immutable snapshots,
closed-bar fills, immutable armed plans, and forward-only promotion cohorts
(all specified below and in the sibling docs). Otherwise repeated rule changes
just overfit the live stream.

## System boundaries

**Isolated mechanics, shared promoted intelligence.**

```
Fomo trader / wallet grading systems (EXISTING — untouched)
  └─ own state, scores, paper books, lifecycle, promotion rules
       │
       │  one-way, snapshot-only, lagged projections
       ▼
┌─────────────────────────────────────────────────────────┐
│ Smart Money Context (per scan, frozen)                   │
│  · promoted wallet cohort membership + tier @ timestamp  │
│  · promoted Fomo trader cohort membership + tier         │
│  · per-token cohort overlap (promoted wallets holding /  │
│    buying; promoted trader participation / active theses)│
│  · convergence-like facts recomputed from promoted        │
│    cohort snapshots only                                  │
└─────────────────────────────────────────────────────────┘
       │
Sentiment bucket (per scan, frozen)                        │
  · gauge basket = main watchlist `tracking` tokens        │
  · narrative outputs (stage, momentum, provenance)        │
  · CoinGecko Trending (membership, turnover, overlap)     │
  · Fomo Trending — AGGREGATE surface only                 │
  · Dex-scan breadth (qualifying count, median liquidity,  │
    % red-flag shapes)                                     │
       │                                                   │
       ▼                                                   ▼
┌─────────────────────────────────────────────────────────┐
│ TRADE PIPELINE (NEW — fully separate state + jobs)       │
│ scanner → features/gates → thesis/plans → paper executor │
│ → review → tuning gauntlet                               │
└─────────────────────────────────────────────────────────┘
```

Hard rules:

- The pipeline **never writes** into watchlist, wallet, Fomo, narrative,
  source, ledger, or research-queue state. All imports are read-only
  projections frozen into the pipeline's own snapshots.
- Smart Money Context contains **membership and tier of already-promoted
  cohorts only** — never raw trade feeds, unsettled outcomes, mutable scores,
  account-level Fomo data, or holder overlays. Cohorts enter with the same
  one-epoch lag discipline the rest of the system uses (INV-S14 spirit): only
  cohorts promoted from outcomes available before the trade decision.
- When a promoted cohort changes, only **future** plans see the new cohort;
  active plans keep the context frozen at plan time.
- A gauge token is **not** automatically a trade candidate. It becomes
  tradable only if it independently appears in the day's Dex scan and passes
  the same eligibility gates as any other candidate.
- The one deliberate upstream dependency: candidates inherit the existing
  security gate + canonical identity resolution (`(chain, token_address,
  pair_address)`) rather than duplicating them. One-directional — the
  watchlist never knows the trading pipeline exists.

## Candidate universe (scanner)

- ~150 candidates/day per chain surface, as **several fresh bounded batches**
  (default 6 × 25) rather than one daily scrape, so the universe stays fresh
  across the day and every selection is timestamped.
- v1 eligibility floor: **≥ $1M market cap** (article default). A lower-cap
  band is a later, separately-capped shadow experiment — never mixed into the
  headline book.
- Universe integrity is a first-class requirement: record the exact query,
  filters, ranking, pagination, raw response hash, and timestamp of every
  scan batch. The system must be unable to quietly cherry-pick names after
  seeing moves.
- Provider: Dexscreener ranking is the reference (the article's manual flow);
  final choice per [data-and-providers.md](data-and-providers.md) — ranking
  provider and bar provider may differ.

## Chain model

- **v1: Solana only.** Then **Base** and **Robinhood**, then expand as
  rotations shift.
- Chains are first-class, not fallbacks:
  - Lifecycle A/B/C thresholds chain-calibrated (launch curves, liquidity
    persistence, and volatility differ per chain).
  - Per-chain policy values: bar cadence, volume/liquidity floors, max
    position share of pool volume, slippage assumptions.
  - Scorecards sliced per chain from day one.
- **One book, many markets:** a single chain-agnostic USD-equivalent bankroll
  and risk engine. Each position's loss-at-invalidation charges the same
  global risk budget, so the system can compare opportunities across chains.
- **Rotation detection is evidence, not narrative:** compare gauge baskets,
  trending surfaces, eligible-candidate counts, and realized per-setup
  expectancy across chains. Capital rotation needs hysteresis and cooldowns
  (a rotation governor) so daily noise cannot churn the book between chains.

## Identity and price discipline

- One executable **canonical pair** chosen at plan creation and kept stable
  for the plan's life. Charts may display market cap, but fills, liquidity,
  slippage, stops, and P&L always use the tradable pair price.
- Multi-timeframe: 15m/1h for lifecycle, fib anchors, zones, trend structure;
  **1m/5m for fills and stop/target ordering** (on these charts a single 5m
  bar can hit entry, target, and invalidation — see
  [execution-and-risk.md](execution-and-risk.md)).

## Proposed state layout (host-owned unless noted)

```
agent/state/trading/
├── policy.json            # versioned tunable knobs (allowlisted, ADR 038/039 pattern)
├── plans/                 # agent-authored thesis/plan proposals → host-validated, frozen
├── positions.json         # host-only paper book (INV-S10 pattern; no model writes)
├── trades.json            # closed trades with full attribution records
├── setup-scoreboard.json  # rolling decayed per-setup × regime × chain hit rates
└── universe/              # per-batch scan snapshots (query hash, candidates, features)
```

Archive mirrors follow the existing snapshot/provenance conventions
(`~/.trenchcoat/archive/`), including sentiment-bucket and Smart Money Context
snapshots per scan.

## Proposed jobs

| Job | Cadence (initial guess) | Role |
|---|---|---|
| `trade-scan` | several/day per chain | scanner batches, feature snapshots, sentiment + smart-money context freeze |
| `trade-plan` | after scan | agent session: select setups from host-computed candidates, author plan proposals; host validates + arms |
| `trade-sim` | 1–5m tick | deterministic paper executor on closed bars: triggers, tranches, invalidation, trailing, expiry |
| `trade-review` | daily | post-mortems, scoreboard update, no-trade-day records |
| `trade-tune` | weekly | agent proposes policy diffs; forward-only gauntlet ([promotion-and-tuning.md](promotion-and-tuning.md)) |

All follow existing orchestrator idioms: journalled runs, archived inboxes,
proposal validation, integrity checks, receipts.

## Division of labour (the repo's core idiom, applied)

- **Host computes, agent selects.** Fib grids, swing points, trendline fits,
  order-zone boxes, lifecycle classification, and chart-quality features are
  deterministic host math over archived bars. The host emits a **bounded
  candidate set** (INV-S16 dossier pattern); the agent's judgment picks which
  setup/anchors and declares confluence; the host verifies every numerical
  relationship before a plan arms. An agent-drawn line is neither reproducible
  nor auditable — a host-verified selection from host-computed candidates is
  both.
- **Plans are contracts** (fields in
  [execution-and-risk.md](execution-and-risk.md)); once armed, immutable.
- **The book is host-only.** Fills, P&L, and position state are written by
  deterministic orchestrator code exclusively — same ownership pattern as
  `ledger.json`/INV-S10.

## Invariant candidates (to register in INVARIANTS.md when built)

Draft IDs, to be finalised at implementation:

- **INV-T1** — trade pipeline state is written only by deterministic host
  code; agent sessions write plan/policy proposals only.
- **INV-T2** — no trade-pipeline code path writes watchlist, wallet, Fomo,
  narrative, source, ledger, or research-queue state.
- **INV-T3** — Smart Money Context and sentiment inputs are snapshot-frozen at
  scan time, built only from already-promoted (lagged) cohorts and aggregate
  trending surfaces; account-level Fomo data never enters.
- **INV-T4** — an armed plan is immutable; policy changes affect only future
  plans; every fill cites closed-bar evidence with input hashes.
- **INV-T5** — scan batches are integrity-recorded (query, ranking, response
  hash, timestamp); candidates cannot be added retroactively.
- **INV-T6** — paper fills use adverse ordering when intra-bar sequence is
  unknowable; missing provider data never invents a fill or a price.
- **INV-T7** — capital-phase promotion (paper → dollar → bankroll) requires
  the documented gates; no policy version reaches a funded phase without
  passing the gauntlet on sealed forward cohorts.
- (Live phase, later) **INV-T8** — the decision host never holds execution
  keys; trade intents cross to the airgapped executor only via the
  authenticated, allowlisted API. Requires a new ADR revisiting INV-A1
  before the dollar phase goes live.

## Live execution architecture (later phase, recorded now)

- Separate VPS running a **dumb, deterministic executor**: no model anywhere
  near it, IP-gated + HMAC/mTLS-authenticated trade-intent API, local
  enforcement of max size / daily caps, DEX program allowlist (e.g. Jupiter
  only), hardcoded withdrawal allowlist, kill-switch file.
- Brain never holds keys; executor never thinks. Preserves the spirit of
  INV-A1 on the decision box; the executor box is a new, explicitly-scoped
  exception that needs its own ADR + hardening review before any funded phase.
