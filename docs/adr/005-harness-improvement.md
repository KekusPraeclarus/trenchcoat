---
description: ADR — Bounded harness improvement loop with sealed-audit feedback and agent-gated promotion.
status: accepted
date: 2026-07-16
last_verified: 2026-07-20
---

# ADR 005 — Bounded harness improvement loop

## Context

Performance self-audit was specified as an action log plus periodic audit of
actions versus outcomes. Recursive Self-Improvement (RSI) of the harness was
misread as Relative Strength Index. A free self-modifying skill loop conflicts
with auditability (INV-S5) and was rejected with Hermes.

We still want the system to refine decision policy from sealed scorecards, but
only through a host-owned, leakage-free lane with non-waivable deterministic
gates. Human PR review is replaced by an independent review agent; the operator
retains kill switches and rollback.

## Decision

1. Name the loop **Harness Improvement Loop** — never overload RSI.
2. Improvement orchestration is **host-only** under
   `~/.trenchcoat/harness-improvements/`. The `harness-improve` job may run on a
   schedule, plan with a read-only agent, require an independent plan review,
   build only after approval, grade with single-use holdout replay, require an
   independent implementation review, fast-forward **local** `main`, and deploy
   the host runtime — but it never pushes to `origin`, never rewrites history,
   never activates `~/.trenchcoat/agent` while the all-work drain gate is busy,
   and never starts a canary until activation.
3. Autonomous mutation is limited to
   `agent/skills/decision-policy/policy.json`. Audit maths, harness code,
   router, chat, collectors, secrets, docs, and evaluation fixtures are
   forbidden. Agents cannot expand their own allowlist.
4. Runtime sessions emit **typed decision proposals** only; host code validates
   and applies watchlist/ledger/decisions mutations (INV-S1/S2/S10).
5. Offline evaluation requires distinct development and holdout sealed epochs
   with archived decision-time signals, path confinement, full `test:all`,
   safety floors, protected-metric non-regression, and holdout single-use.
6. Live canaries may assign a configured fraction (default 10%) of internal
   decision episodes to a candidate **policy version**. Candidate external
   effects (broadcast, router, X mutations, wallet lifecycle) are blocked.
   Paired baseline/candidate records are append-only. Rollback routes future
   assignments to baseline and reverts via a normal git revert + redeploy.
7. Promotion is **agent-gated** after canary maturity and a final independent
   review receipt. Deterministic gates remain non-waivable: a review agent may
   reject but cannot approve a candidate that fails schema, confinement,
   quality, test, repository, canary, or deployment gates.
8. Host runtime deploy and agent-workspace activation are separate. Agent
   instruction sync waits for the all-work drain predicate and never overwrites
   state/inbox/outbox/reports/alpha-queue. Launchd redeploy waits for
   `isAgentIdle` (in-flight only) before `bootout`/`kickstart` so KeepAlive
   reloads do not kill mid-session Cursor/host work; full drain remains the
   activation gate.

## Consequences

- Config schema 11 defaults `harness_improvement.enabled` and
  `schedule_enabled` to `true` for new/missing fields; explicit operator
  `false` values remain authoritative across migration.
- CLI / job: `tc run harness-improve`, `tc harness run|activate|drain|*`.
- Scheduled path ends at `activation_pending` with a pending agent-deployment
  manifest; `tc harness activate` performs drain-gated sync + canary start.
- Launchd installs `harness-improve` by default; `--without-harness` opts out.
- INV-S23–S25 cover proposal ownership, harness confinement, and canary egress
  blocking.
- Relative Strength Index remains the chart feature under `indicators.rsi_*`.

## Enforcement

- `src/orchestrator/proposals.ts`, `src/orchestrator/scorecard.ts`, `src/harness/**`
- `docs/architecture/harness-improvement.md`, INV-S23–S25
