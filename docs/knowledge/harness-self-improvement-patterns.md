---
description: External harness-RSI research mapped to trenchcoat's bounded improvement loop — what we already have, what to borrow, what to reject.
scope: project
status: active
last_verified: 2026-07-24
read_when:
  - Extending src/harness/** proposal, evaluation, or plan/review prompts.
  - Considering meta-harness, improver self-edit, evolutionary search, or broader editable surfaces.
---

# Harness self-improvement patterns

Source: Lilian Weng, [*Harness Engineering for Self-Improvement*](https://lilianweng.github.io/posts/2026-07-04-harness/)
(2026-07-04). Survey of ACE / MCE / Meta-Harness / Self-Harness / AHE / ADAS /
AFlow / STOP / DGM / AlphaEvolve. **Unverified beyond the survey text** — treat
cited paper results as literature claims, not as measured on trenchcoat.

Binding local design: [ADR 005](../adr/005-harness-improvement.md),
[ADR 038](../adr/038-improver-self-edit-boundary.md),
[ADR 039](../adr/039-bounded-improver-config-lane.md),
[harness-improvement.md](../architecture/harness-improvement.md), INV-S24.

## Already aligned / implemented (do not re-litigate)

| Pattern (survey) | trenchcoat |
|---|---|
| Workflow plan → execute → evaluate → accept | `harness-improve`: propose → plan → plan-review → build → `test:all` → holdout → manifesto → impl-review → integrate → activation → canary |
| File system as durable state | `~/.trenchcoat/harness-improvements/<id>/`, sealed epochs, rejection receipts |
| Sub-agents with inspectable artifacts | planner / reviewer / builder; independent review cannot waive gates |
| Self-Harness propose–evaluate–accept | Same shape; holdout single-use + protected-metric floors |
| Evaluator / harness code outside editable surface | INV-S24: `policy.json` + bounded `config/harness-improver.json` only; audit maths, router, `src/harness/**` gates forbidden |
| Reward-hacking controls | Held-out epochs, canary egress block, kill switches, rollback |
| Weakness mining (Self-Harness) | Host `weakness-mining.ts` clusters sealed decision outcomes + signals into typed patterns; writes `weakness-report.json` into propose/plan context |
| Decision observability / manifesto (AHE) | Plan schema v2: `evidenceIds`, `rootCauseHypothesis`, `predictedFixes`, `atRiskRegressions`; `manifesto-validation.json` fails on unpredicted protected regression |
| Preserve passing behaviours | Host `keep-summary.json` from development-epoch hits under baseline; planner reads alongside scorecard |
| Negative-result archive | Host `prior-attempts.jsonl` (+ per-hypothesis summary); rebuildable from rejection/rollback receipts |
| Bounded improver-config lane (STOP-shaped, safe) | [ADR 039](../adr/039-bounded-improver-config-lane.md): shadow `config/harness-improver.json` trials, host meta-utility (≥8 pairs), **operator-only** `tc harness meta promote` |

## Improver improving itself (vs policy / agent harness)

Three layers (see [ADR 038](../adr/038-improver-self-edit-boundary.md) /
[ADR 039](../adr/039-bounded-improver-config-lane.md)):

| Layer | What | Autonomous edit? |
|---|---|---|
| Agent runtime harness | sandbox, skills, collectors, router | No |
| Decision policy | `policy.json` | Yes (ADR 005) |
| Improver | `src/harness/**`, gates, propose heuristics | Code/gates: **no**. Config knobs: **yes**, only `config/harness-improver.json` under ADR 039 shadow + operator promote |

Implemented shape: immutable outer shell (confinement, holdout, protected metrics,
allowlist constants, meta-utility weights) + paired offline trials. Default
runtime keeps baseline / last-promoted config until `tc harness meta promote`.
Live acceptance should run shadow trials only — never auto-promote in
verification.

## Explicitly reject (conflicts with INV-S24 / ADR 005 / ADR 038 / ADR 039)

| Pattern | Why not |
|---|---|
| Meta-Harness / DGM evolving harness **code** | Agents must not expand their allowlist or edit evaluator / install / router |
| Autonomous improver self-edit of floors / gates | Same reward-hacking class; ADR 038/039 shell |
| Auto-activate meta before eight pairs | Sample starvation; utility is host-owned and non-configurable |
| Unconstrained evolutionary populations over harness variants | Trading metrics are noisy/slow; `one_active_experiment` + canary cost dominate |
| Joint weight updates (SIA / Continual Harness) | No weight access; Cursor CLI login auth (ADR 003) |
| Free-form ACE playbook rewrite of agent prompts from scraped trajectories | Inbox/scraped text must not enter harness prompts; sealed inputs only |

## Practical caution from the survey

- STOP: recursive improver loops help only when the base model is strong enough;
  we already gate plan/build/review on capable models — do not weaken that.
- Lin et al.: harness-*updating* ≠ harness-*benefit*; a good edit still needs
  the runtime agent to follow the new policy — canary maturity remains the real
  promotion bar.
- Fuzzy evaluators and reward hacking remain the binding risks; keep human
  kill switches and never move gates inside the editable surface.
