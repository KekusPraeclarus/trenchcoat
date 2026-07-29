---
description: Trading pipeline execution contract - trade-plan fields and immutability, paper fill simulation rules (closed bars, adverse ordering, slippage model), risk-at-invalidation sizing, portfolio limits, and safety exits. NOT BUILT YET.
scope: project
status: planned
last_verified: 2026-07-29
---

# Execution and risk

## 1. The trade-plan contract

A plan is authored by the agent (from host-computed candidates), validated by
the host, and **frozen once armed**. Required fields:

| Field | Notes |
|---|---|
| `planId`, `policyVersion` | every plan cites the exact policy hash that produced it |
| `identity` | canonical `(chain, tokenAddress, pairAddress)`; pair chosen at plan time and stable for the plan's life |
| `setup` | S1/S2/S3 + the selected host-candidate ids (fib grid hash, line id, zone id) |
| `lifecyclePhase` | must be B at arm time |
| `entryZone` | price band, not a point |
| `triggerWindow` | validity window; unfilled at expiry ⇒ `expired` (logged — missed-trigger opportunity cost stays measurable) |
| `invalidation` | structural level (decisive-close semantics), never a bare % |
| `targets` | T1/T2/T3 with tranche fractions |
| `trailing` | rule activated after T1 (e.g. trail from post-T1 high; parameters are policy knobs) |
| `timeStop` | max holding period; dead money exits |
| `convictionTier` | from confluence count + context; determines risk budget |
| `confluence` | the declared independent signals, each citing host feature ids |
| `smartMoneyContext` | frozen snapshot reference (v1: shadow metadata, no policy influence) |
| `sentimentRegime` | frozen bucket reference |
| `expectedCosts` | fee + slippage estimate used for cost-adjusted P&L |

Host validation before arming: internal consistency (invalidation < entryZone
< targets for longs), minimum R:R floor, size within tier cap, liquidity
gates, identity bound, lifecycle B, chart-quality gate passed. Rejected plans
are receipted with reasons.

**Immutability:** once armed, the agent cannot move invalidation, targets, or
expiry. A new plan may be created only after the old one closes or expires.
This is the anti-thesis-drift rule — hiding bad decisions by editing them is
structurally impossible.

## 2. Paper fill simulation

- **Closed-bar evidence only.** No partial candles, ever. 1m/5m bars drive
  fills; 15m/1h drive structure.
- **Entries:** fill only when a closed bar's range intersects the entry zone
  inside the trigger window. Fill price = conservative side of the zone
  touched, plus modelled slippage.
- **Exits:** invalidation breach (decisive-close semantics), tranche targets,
  trailing stop, time stop — whichever the bar evidence supports.
- **Adverse ordering:** when entry, target, and invalidation are all touched
  within one bar and intra-bar sequence is unknowable, the simulator must
  assume the **adverse order** (worst case for the book). On these charts a
  single 5m bar can plausibly hit all three; without 1m or event-level
  sequencing, optimistic ordering would make paper results fiction.
- **Costs:** every fill applies the fee + slippage model; slippage scales with
  planned size vs pool liquidity/volume. The $1 (dollar) phase exists
  specifically to calibrate this model against real fills — expected vs
  realized slippage is recorded per trade from paper onward.
- **No invented data:** missing/stale provider bars never produce a fill, a
  mark, or a loss (the settlement idiom: pending, never invented).

## 3. Sizing — risk at invalidation

The core rule (playbook chapter 7 formalised):

```
allowed_dollar_loss = bankroll × tier_risk_budget
position_notional   = allowed_dollar_loss / (entry_price − invalidation_price)
```

Then cap by, in order:

1. **Liquidity cap** — max share of pool volume/liquidity (chain-calibrated;
   protects the future live phase from impact fantasy)
2. **Max notional cap** — absolute per-position ceiling
3. **Aggregate exposure cap** — total open risk across the book
4. **Per-narrative/cluster concentration cap** — correlated shitters count
   together

A strong setup earns a larger **risk budget** (conviction tier), never a
bypass of the caps. Bankroll is chain-agnostic USD-equivalent; every
position's loss-at-invalidation charges the same global risk budget so
cross-chain opportunities compete for capital honestly.

Capital-phase overlay ([promotion-and-tuning.md](promotion-and-tuning.md)):
paper = virtual bankroll; dollar = $1 max risk per trade; bankroll = 1%
baseline risk × promoted tier schedule.

## 4. Portfolio risk rules

- **Daily loss limit** — settled paper losses beyond the limit pause new plan
  arming until the next day; the pause is visible in the next scan's inbox so
  the agent sees why.
- **Drawdown kill-switch** — book drawdown beyond a hard threshold suspends
  the pipeline pending operator review.
- **Max concurrent positions** — policy knob.
- **No-trade is a success state** — every scan cycle may conclude "no
  qualifying setup" and that conclusion is recorded as a first-class outcome
  (prevents scan cadence from manufacturing exposure, and gives review data
  on selectivity).

## 5. Safety exits (independent of thesis)

Fire regardless of plan state; conservative close/suspend of simulated
positions and cancellation of pending entries:

- liquidity disappearance / LP drain on the canonical pair
- pair migration or identity change
- stale price stream beyond threshold
- security-gate regression on the token (re-checks inherited from the main
  gate)
- abnormal disagreement between price providers

Safety exits are receipted with their trigger evidence and excluded from
setup-quality attribution (they grade the safety net, not the setup).

## 6. Attribution record (every closed trade)

Each trade record carries: setup + candidate ids, chain, lifecycle phase at
entry, conviction tier + confluence signals, sentiment regime, smart-money
context flags, policy version, entry/exit fills with bar hashes, expected vs
realized slippage, tranche history, exit reason (target / invalidation /
trailing / time / safety / manual), and P&L gross + cost-adjusted. This is the
audit trail the self-improvement harness mines — it must be complete from
trade one.
