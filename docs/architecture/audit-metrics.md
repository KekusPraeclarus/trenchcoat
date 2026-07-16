---
description: Audit metric definitions - hit events, horizons, benchmark excess returns, calibration binning, paper-ledger conventions, broadcast precision, discovery-funnel counterfactuals. The formulas that make the scorecard mean something.
scope: module
status: draft
last_verified: 2026-07-16
read_when:
  - Editing src/orchestrator/audit.ts or interpreting scorecard numbers.
---

# Audit metrics

All maths here is deterministic host code over immutable as-of bundles and
outcome observations (snapshot-archive.md). The audit agent session narrates
these figures; it never computes them (INV-S4).

Every number below is an **initial default, expected to be tuned after the
first few audit cycles** — but tuned by editing this doc and the config in the
same change, never silently.

## Audit epochs

An audit is a reproducible epoch, not "whatever was eligible when the weekly job
ran". Before fetching outcomes the orchestrator freezes an epoch manifest with:

- `epoch_id`, `previous_epoch_id`, `started_at`, and an immutable `cutoff_ts`
- config hash, indicator-spec version, execution-model version, and code commit
- the exact decision, resolution, discovery, broadcast, and source-call event ids
  eligible at the cutoff
- the prior source-score update cutoff, which is the latest call-event time allowed
  to affect this epoch's source scores

Eligibility uses event time. An outcome joins only when
`event_ts + horizon + settlement_delay <= cutoff_ts`; the initial settlement
delay is 6h. Late jobs therefore produce the same cohort as an on-time job with
the same cutoff. A crash resumes the incomplete epoch by id. Completion writes
the outcome records and scorecard atomically, then seals the manifest with hashes.
Re-running a sealed epoch is a verification operation and must be byte-identical.

Provider corrections never rewrite a sealed observation. A correction is an
append-only superseding record with its reason, and a later epoch names the
revision it selected. Numerators, denominators, excluded counts, and exclusion
reasons are persisted for every aggregate so no percentage can hide missing data.

Before network calls, the epoch planner groups subjects by provider, pair, and
time range, subtracts content-addressed candles already archived, and fetches the
widest missing range once. One payload can satisfy multiple decisions/horizons,
MFE/MAE, ledger marks, resolution candidates, and source events. Request, retry,
cache-hit, and unresolved-range counts are persisted so audit cost is itself
auditable.

## Horizons

Every verdict is priced at **+24h, +72h, +7d** from `decision_ts`.
**+72h is the headline horizon**; the others are diagnostic. A verdict enters
an audit only once its horizon has fully elapsed — no partial-window grading.
Each horizon is its own immutable outcome record, so a +24h result never changes
when +72h matures.

## Returns

For subject event *e*, `P₀` is the first eligible 5m candle open whose interval
starts at or after `event_ts`; `Pₕ` is the equivalent observation at or after
the horizon. `event_ts` is decision time for verdicts, drop time for drop
vindication, mention time for source/resolution events, and first-seen time for
discovery records. Both prices are post-event references, not pre-session
quotes. A decision's pre-event bundle remains the evidence record and never
doubles as an execution price.

- Raw return: `r = Pₕ / P₀ − 1`
- **Excess return** (the scored number): `x = r − r_benchmark`, where the
  benchmark is the chain's native asset over the same window (chains.md).
  This stops a bull tape from grading luck as skill.
- Gross returns and a cost-adjusted estimate are both reported. The estimate
  applies a versioned per-side fee assumption and a conservative liquidity-impact
  stress model from the observation's pool liquidity. For side notional `N` and
  observed USD liquidity `L`, estimated side cost is
  `N × (fee_bps / 10,000 + min(1, 2N / L))`. It deliberately approximates a
  constant-product pool with half the reported liquidity on the paid side; it is
  a comparable stress estimate, not a claim about a pool's exact routing. The
  initial fee assumption is 50 bps per side. All assumptions are visible in the
  epoch manifest.
- A verified rug with no recoverable token liquidity scores `r = −1`. A missing
  pool or provider response does not: the resolver follows same-chain pool
  migrations by token address and records the path. Remaining gaps are
  `provider-pending` or `censored`, excluded from performance numerators and
  surfaced in outcome-coverage metrics.

Every observation stores provider, fetch time, candle interval and timestamp,
token/pair identity, price, liquidity, benchmark observation, raw-input hash,
quality flags, and any migration or terminal-event evidence.

## Per-verdict scoring

| Verdict | Hit definition (headline horizon) |
|---|---|
| `track` | excess return ≥ +20% |
| `drop` | vindicated iff the token's excess return after drop ≤ 0 (holding on would not have paid) |
| `ignore` | correct iff excess return < +20% (else it is a **counterfactual miss**) |
| `revisit` | deferral latency and eventual disposition only; not scored as a directional call |

The table's event is computed at every configured horizon; +72h is merely the
headline. Hit/miss rates, drop precision, and calibration always retain +24h and
+7d diagnostics under the same cohort rules.

- **Track-call hit rate** = hits / all tracks past horizon
- **Drop precision** = vindicated drops / all drops past horizon
- **Counterfactual miss rate** = misses / all ignores past horizon
- **MFE/MAE** — max favourable/adverse excursion within the horizon window
  (from hourly OHLCV), reported per track to separate thesis-right-timing-wrong
  from plain wrong

Overlapping decisions for the same token share an `episode_id`. Headline rates
count one terminal call per episode; per-decision diagnostics remain available.
Scorecard confidence intervals and comparisons use episode/source-cluster-aware
resampling rather than pretending correlated observations are independent.

## Paper ledger

- One virtual position per track, fixed $1,000 notional. Entry uses the first
  post-decision execution reference above; confidence-weighted sizing remains
  disabled until calibration is proven.
- A drop closes the position at the first eligible 5m open after `drop_ts`.
  Otherwise it stays open and marks to the latest fully closed 5m candle at the
  epoch cutoff. This is the action-realised + mark-to-market book the bot could
  actually have produced.
- Headline paper P&L reports gross and cost-adjusted realised P&L, unrealised
  P&L, and total equity, raw and benchmark-hedged. The fixed +72h cohort return
  is shown beside it for time-normalised comparison.
- Peak close, MFE, MAE, and first-underwater time remain diagnostics only. They
  never book an exit or contribute to headline P&L because the peak is knowable
  only in hindsight.

## Calibration

Decisions binned by confidence: 0–20, 20–40, 40–60, 60–80, 80–100.
Per bin: predicted midpoint vs realised hit rate, with bin counts (a bin under
10 independent episodes is reported but flagged low-n), Wilson interval, and
outcome coverage. Scorecard carries the full curve, expected calibration error,
and **Brier score** over eligible track, ignore, and drop cards. Confidence means
the probability that the card's own verdict is correct: track hit, ignore not a
miss, or drop vindicated. Revisit has no directional correctness event and is
excluded. Per-verdict curves are shown before any pooled curve so different base
rates cannot hide miscalibration.

Calibration is also sliced by declared driver role, but only when the slice has
enough independent episodes. Empty and tiny slices are counts, not conclusions.

## RSI evaluation and rule promotion

RSI is audited as a versioned feature, never as an after-the-fact story. Each
decision bundle records both 1h and 4h RSI values, prior values/deltas, exact bar
cutoffs, validity flags, and raw-input hashes. The decision card records whether
RSI was `driver`, `confirm`, `veto`, or merely `observed`. Audits retain the full
cohort, including losses, ignores, invalid RSI, and calls where the model did not
use RSI.

Candidate RSI rules are pre-registered in the epoch manifest before seeing their
evaluation outcomes. They run in shadow and are compared by horizon, action,
chain, liquidity band, token age, and market regime. Exploratory associations are
labelled exploratory and cannot change config.

Promotion into deterministic token resolution is deliberately strict:

1. labels come only from later raw-CA ground truth, never the price/volume proxy
2. events are deduped by token and source cluster
3. the rule and metrics are frozen before a forward-only holdout begins
4. at least 100 independent ground-truth events overall and 40 in the untouched
   holdout are required
5. the rule promotes only when its 95% confidence-bound improvement over the
   current resolver baseline is positive without a material abstain-recall loss
6. a developer changes the resolver and docs; the audit never promotes itself

A rejected candidate version never reuses that holdout. A promoted rule remains
shadow-monitored for drift and automatically falls back to the model path when
its inputs are invalid.

## Broadcast precision

Every proposal carries a typed `audit_claim` with subject identity, direction,
horizon, and a host-owned verification-rule id. Token-upside requires the
configured positive excess move; token-downside/sentiment-collapse requires the
configured negative move or verified terminal loss. Direction is never discarded
into an absolute "large move".

Narrative rules use archived external measurements, never a later model-authored
stage as their own proof: effective mention share/velocity across independent
clusters, category attention, and chain-relative market/volume movement must
cross the named rule and persist across two subsequent scans. Rotation requires
both a declining source narrative and rising destination narrative. Proposals
without a valid, measurable rule are rejected by the outbox validator as
unauditable.

Precision, recall against all host-detected qualifying events, lead time, and
unresolved outcome coverage are reported per claim type and severity. `urgent`
keeps its own line (INV-B4's abuse metric).

## Source-quality deltas

Source quality is based on direct, host-derived **bullish call events**, not the
bot decision that happened to cite a source. A call event requires a raw CA/pair
match plus an explicit positive-call pattern from a deterministic, versioned,
negation-aware parser. Warnings, neutral mentions, copied items, and uncertain
stance are excluded; parser coverage and exclusions are scorecard metrics.

Each eligible event is priced from its own mention timestamp at the standard
horizons, deduped by source/identity/window and independence cluster. Per-source
quality is a 30-day-half-life decayed hit rate with a neutral Beta prior of
strength 10. Event weight at the epoch cutoff is
`w = 2 ^ (−age_days / 30)`, and
`score = (5 + Σ(w × hit)) / (10 + Σw)`. The prior
prevents one lucky call from creating an elite source. Score, decayed effective
sample size, and 95% interval are persisted; scan weighting remains near neutral
while uncertainty is high. It is applied with the one-cycle lag
(snapshot-archive.md). Rug-dock penalties and adjacency remain separate and are
never averaged away by good calls. Model-authored citations and classifier
outputs never participate in source score writes (INV-S12).

## Disambiguation grading (resolution log)

For every resolution-log record past the headline horizon, the audit prices
**all shortlist candidates** from `mention_ts`. A later raw CA from the same
source context is the only promotion-grade target label. Price/volume separation
is retained as an explicitly proxy-labelled diagnostic:

- **Ground-truth target** = a later raw CA from the same source context
- **Proxy target** = absent ground truth, the candidate whose post-mention excess
  move and volume reaction are shill-shaped while the rest stay flat
- no clear separation → `undetermined`
- Grades: **pick-correct** / **pick-wrong** (confirms), **abstain-missed**
  (a clear winner we passed on) / **abstain-right** (abstains)
- Scorecard lines split ground-truth and proxy cohorts: disambiguation precision,
  abstain-missed rate, proxy share, and undetermined share
- **RSI-signature association** is split the same way. Proxy-labelled association
  is exploratory only because its label is partly defined by the subsequent move
  and would otherwise create a circular promotion test

## Discovery-funnel counterfactuals

The host-side discovery log (`~/.trenchcoat/archive/discovery-log.jsonl`,
appended by the research-queue expiry/rejection sweep) records every candidate
that was surfaced but never researched. The audit prices all eligible records
when possible. If the rate budget requires sampling, selection is deterministic
and stratified by rejection reason, chain, trigger, and time bucket; the epoch
stores inclusion probability and sampling seed so weighted estimates are
reproducible:

- **Filter recall loss** = counterfactual hits among priceable non-security
  rejects/expiries / all priceable non-security rejects/expiries
- **Gate catch rate** = verified terminal losses among outcome-resolved scanner
  hard-fails / all outcome-resolved scanner hard-fails
- **False-block rate** = counterfactual hits among outcome-resolved gate or
  market-quality blocks / all outcome-resolved blocks
- **Queue-cap miss rate** = counterfactual hits among capacity-blocked records /
  all priceable capacity-blocked records
- **Caution loss lift** compares passed tracks carrying each caution flag with
  clean passes at the same horizon, with counts and uncertainty

These funnel metrics are what justify (or indict) every threshold in
security-gate.md and the queue cap. Each is split by typed reason; aggregate
rates never mix scanner hard-fails, market-quality deferrals, ambiguity, stale
data, unsupported chains, and capacity pressure.

## Scorecard fields (state/scorecard.json)

`epoch` (id, cutoff, versions, input/output hashes), `paper_pnl` (action-realised
+ MTM, gross + cost-adjusted, raw + hedged), `fixed_horizon_pnl`, `hit_rate` per
horizon, `drop_precision`, `counterfactual_miss_rate`, `outcome_coverage`,
`excursions` (MFE, MAE, first-underwater distributions),
`calibration` (bins + Wilson intervals + ECE + Brier), `rsi` (cohorts, shadow
rules, drift), `broadcast_precision` per severity, `disambiguation`
(ground-truth/proxy precision, abstain-missed rate, proxy/undetermined share),
`filter_recall_loss`, `gate_catch_rate`, `false_block_rate`,
`queue_cap_miss_rate`, `caution_loss_lift`, `source_quality` (coverage,
effective sample sizes, deltas), `tokens_per_run`, and `api_cost` (requests, retries,
cache-hit rate), plus `index_token_estimate` and archive-growth bytes. Every
aggregate carries numerator, denominator, exclusions, and confidence interval.
`archive_health` records last verified backup, hash failures, unreachable blobs,
and pending garbage collection. Schema-versioned; written only by the audit
job's host phase.
