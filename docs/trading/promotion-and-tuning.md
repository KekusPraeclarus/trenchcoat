---
description: Trading pipeline governance - policy versioning, the agent tuning lane and forward-only gauntlet, capital-phase promotion gates (paper → dollar → bankroll), and the smart-money v1 decision. NOT BUILT YET.
scope: project
status: planned
last_verified: 2026-07-29
---

# Promotion and tuning

## 1. Policy objects

All tunable behaviour lives in a versioned, allowlisted
`agent/state/trading/policy.json` (ADR 038/039 confinement pattern):
setup enables/weights, fib level preference, decisive-close definitions,
trigger windows, tranche fractions, trailing parameters, time stops, tier
risk budgets, caps, chain calibrations, scanner filters. Every plan cites the
exact policy hash that produced it; funded phases only ever run **promoted**
policy versions.

The agent proposes policy diffs; deterministic host gates decide. The improver
may never touch: the fill simulator, the risk caps' enforcement code, the
gauntlet/promotion machinery, attribution records, or the allowlist itself
(same self-edit boundary as ADR 038).

## 2. The tuning gauntlet (forward-only)

Because the pipeline is live-paper-first, tuning is **forward-only shadow
evaluation** — the harness canary skeleton applied to trading policy:

1. **Propose** — agent authors a policy diff with rationale citing scoreboard/
   review evidence.
2. **Shadow** — candidate policy runs against the same future scan stream as
   the baseline, arming shadow plans with external effects blocked. Both books
   see identical universes and bars (paired episodes).
3. **Mature** — shadow plans settle; comparison uses only mature, sealed
   forward trades. Minimum sample and minimum calendar duration required, with
   regime coverage (a policy proven only in one regime is flagged, not
   promoted).
4. **Promote or reject** — deterministic gates on the paired comparison.
   Rejections are receipted and feed the prior-attempts record so the improver
   learns what failed.
5. **Rollback** — sequential-regression detection on a promoted policy forces
   baseline, same as the harness canary (append-only history, never rewritten).

**Protected metrics** (candidate must not regress them while improving its
primary): cost-adjusted expectancy, max drawdown, tail-loss (worst-N average),
hit rate, fill rate (plans armed vs filled), outcome coverage, safety-exit
rate. Profit alone never promotes.

**Gauntlet proportionality:** parameter tweaks *inside pre-registered ranges*
get an abbreviated gauntlet (shorter shadow probation); structural changes
(new setup, new veto, changed decisive-close semantics, changed sizing formula)
get the full ladder. Both still require the funded-phase gates below —
"even a small tweak" never reaches capital without passing through shadow.

## 3. Capital-phase ladder

| Phase | Capital | Purpose | Exit gate (all required) |
|---|---|---|---|
| **Paper** | virtual bankroll | prove process + regime-aware setups; accumulate attribution data | promoted policy beats the naive baseline (raw track-style +72h excess on the same candidates) on sealed forward cohorts; drawdown within bounds; minimum trades + duration + regime coverage; scoreboard shows ≥1 setup with robust positive expectancy |
| **Dollar** | real wallet, **$1 max risk per trade** | calibrate reality: paper-fill vs real-fill delta prices the slippage/latency model's honesty | fill-model delta within tolerance over N trades; no security incidents; executor hardening review passed |
| **Bankroll** | 1% baseline risk per trade | real trading | consistent cost-adjusted profitability across the dollar phase; operator sign-off; kill-switch + daily limits verified live |

Bankroll-phase sizing: 1% baseline risk budget × promoted setup-strength
schedule (conviction tiers), under all caps in
[execution-and-risk.md](execution-and-risk.md). The tier schedule itself is a
policy object and goes through the gauntlet like everything else.

**Before any funded phase:** a new ADR must revisit INV-A1 (advisory-only)
and specify the airgapped executor (separate VPS, IP-gated + authenticated
trade-intent API, local caps, program allowlist, withdrawal allowlist,
kill-switch — see [design.md](design.md) § Live execution architecture).

## 4. Smart Money Context in v1 — the decision

**Settled 2026-07-29:** Smart Money Context ships **in v1**, recorded on every
plan as shadow metadata, with **zero policy influence** at launch.

Rationale (operator wants maximum data + audit trail from the very beginning;
this delivers it without contaminating attribution):

- Every plan and trade carries the frozen cohort-overlap flags from day one,
  so the harness has the full factor history whenever it becomes usable.
- The first attribution question the book must answer cleanly is "do the
  chart setups themselves carry expectancy?" If smart-money context
  influenced decisions from trade one, setup quality and context quality
  would be confounded.
- Once the base book has enough mature trades, the scoreboard can measure
  context lift directly (trades with vs without promoted-cohort
  participation, same setup + regime). Promotion of context from metadata →
  veto/boost/sizing-modifier then goes through the normal gauntlet as a
  policy change, with the pre-existing shadow data as its evidence base.

## 5. Review loop

- `trade-review` (daily): per-trade post-mortems (which exit rule was
  binding; counterfactual "which declared rule would have been optimal" —
  computed from archived bars, so no hindsight leak into decisions), scoreboard
  refresh, no-trade-day records, expired-trigger opportunity-cost log,
  chart-quality-gate rejection outcomes.
- Weekly: the playbook-vs-journal comparison automated — realized expectancy
  per setup vs the policy's assumed edge; divergences become tuning-lane
  inputs.
- Everything lands in the pipeline's own state + archive with provenance, in
  the shape the existing harness mining already consumes (sealed aggregates,
  decision metadata, numeric outcomes — never scraped prose).
