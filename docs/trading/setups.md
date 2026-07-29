---
description: Trading pipeline setup taxonomy - lifecycle classifier, deterministic chart-quality gate, and the v1 setups (first fib retracement, trendline bounce, order-zone revisit) with their features, triggers, and invalidations. NOT BUILT YET.
scope: project
status: planned
last_verified: 2026-07-29
---

# Setups, lifecycle, and the chart-quality gate

All features here are **deterministic host math over closed archived bars**
(15m/1h structure, 1m/5m execution). The agent selects among host-computed
candidates and declares confluence; it never draws lines. Every feature is
versioned and carries input hashes (INV-S17 discipline: contiguous closed
bars only; missing/partial input invalidates the feature).

## 1. Lifecycle classifier (first gate)

Every candidate is classified A / B / C before any setup logic runs.
Thresholds are **chain-calibrated policy knobs**, not global constants.

| Phase | Signature (indicative features) | Pipeline behaviour |
|---|---|---|
| **A — too early** | pair age below threshold; no completed impulse+retracement cycle; discovery volatility; bundle/whale-distribution risk window | No trade by default. (Possible later experiment: micro-tier plans with tight invalidation to learn launch behaviour cheaply — separate shadow policy, never the headline book) |
| **B — sweet spot** | survived launch window; ≥1 completed impulse + structured retracement; higher-low structure or coherent range; holder/liquidity persistence | All v1 setups eligible |
| **C — decay** | higher lows broken / lower highs forming; volume fade vs own baseline; failed reclaim attempts | No new longs. Existing plans run their exits. Candidate drops from active consideration |

## 2. Chart-quality gate (deterministic red-flag rejection)

Purpose: encode "my goal is to find reasons not to trade." Rejects before any
thesis work. Indicative feature set (exact formulas at implementation, all
versioned):

- **Price acceleration** — max short-window return (e.g. 1-bar, 3-bar, 12-bar)
  vs chain-calibrated extremes; near-vertical repricing without staged
  discovery ⇒ reject
- **Volume concentration** — share of trailing volume inside the top N bars;
  a single-bar volume spike dominating history ⇒ reject
- **Flat-then-vertical shape** — long low-variance drift followed by an
  extreme move (the SAMECAT signature) ⇒ reject
- **Wick/range profile** — bar-range distribution consistent with bot volume
  or painted candles ⇒ reject
- **Pre-move liquidity** — liquidity below floor before the move ⇒ reject
- **Boost/promotion flags** — heavy Dexscreener boost activity ⇒ reject or
  penalise
- **Staircase / up-only-on-nothing patterns** — monotonic micro-steps with no
  two-sided trade ⇒ reject

Each rejection is receipted with the failing features, so the gate's
opportunity cost is itself measurable (rejected charts that later performed
are visible in review).

## 3. v1 setup taxonomy

Only these three in v1, Lifecycle B only. Every setup definition specifies:
candidate construction (host), selection (agent), trigger, invalidation,
target logic, and failure/expiry semantics.

### S1 — First fib retracement

- **Candidates:** fib grid anchored origin-of-move → current ATH; redrawn on
  new ATH. Host emits the grid + which levels are as-yet-untested since the
  latest ATH.
- **Trigger:** first meaningful entry of price into a declared level's zone
  after a strong new ATH — later arbitrary touches do not qualify.
- **Level preference** (0.382 / 0.5 / 0.618 / 0.786) is a regime-dependent
  policy knob fed by the setup scoreboard.
- **Invalidation:** structural — decisive close below the next-deeper level
  (not a %-from-entry stop).
- **Targets:** prior ATH region and intermediate structure; constrained by
  downtrend resistance (see vetoes).

### S2 — Respected trendline bounce

- **Candidates:** host-fit lines through major swing lows with ≥3 respected
  touches (2-touch lines may be listed as `forming`, not tradable). Touch
  count, fit tolerance, and lookback are policy knobs.
- **Trigger:** price entering the line's zone with the higher-low structure
  still intact.
- **Invalidation:** decisive close below the line — a wick through it is not
  invalidation. "Decisive" (close distance / bar count) is a versioned
  definition, chain-calibrated.
- **Structural failure:** higher lows → lower highs flips the whole structure;
  the line expires and the setup is blocked on that token until new structure
  forms.

### S3 — Order-zone revisit

- **Candidates:** host-detected boxes (not lines) from (a) post-impulse
  consolidations and (b) prolonged accumulation ranges preceding a breakout.
- **Trigger:** first revisit into the box with Lifecycle B intact.
- **Zone strength decay:** each retest weakens the zone (policy-tunable decay);
  a decisive close through the box **expires it** and blocks re-entry until
  new structure forms.
- **Invalidation:** decisive close below the box.

## 4. Cross-setup vetoes and constraints

- **Downtrend resistance:** host-fit lines through major swing highs. Used as
  (a) a target constraint — targets just below major resistance are trimmed
  or vetoed, and (b) an entry veto — a planned buy immediately below strong
  resistance fails the minimum R:R check.
- **Minimum R:R:** every plan must clear a policy-set floor computed from
  entry zone, invalidation, and first target.
- **Confluence scoring:** independent aligned signals (fib level + trendline +
  order zone + smart-money context + narrative) raise the conviction tier;
  the tier feeds the risk budget (see
  [execution-and-risk.md](execution-and-risk.md)). Weights are policy knobs.

## 5. Setup scoreboard (the adaptation engine)

Rolling, decayed hit rate and expectancy per `setup × chain × regime`
(same half-life-decay idiom as source scores). This is chapter 5 of the
playbook automated: it answers "which setups is the market currently
rewarding?" and feeds:

- setup-level enable/downweight decisions (downweighting is cheap; reviving
  requires evidence),
- the fib level-preference knob,
- conviction-tier adjustments.

Sliced views must respect small-sample honesty: bins under a minimum
independent-trade count are reported but flagged low-n, never acted on
automatically (the audit-metrics calibration conventions apply).
