---
description: ADR — Bounded harness improvement loop with sealed-audit feedback and human-gated promotion.
status: accepted
date: 2026-07-16
---

# ADR 005 — Bounded harness improvement loop

## Context

Performance self-audit was specified as an action log plus periodic audit of
actions versus outcomes. Recursive Self-Improvement (RSI) of the harness was
misread as Relative Strength Index. A free self-modifying skill loop conflicts
with auditability (INV-S5) and was rejected with Hermes.

We still want the system to refine decision policy from sealed scorecards, but
only through a host-owned, leakage-free, human-gated lane.

## Decision

1. Name the loop **Harness Improvement Loop** — never overload RSI.
2. Improvement orchestration is **host-only** under
   `~/.trenchcoat/harness-improvements/`. The `harness-improve` job may run on a
   schedule, create an isolated worktree, build/test, and open a PR — but it
   never merges, never writes production `agent/` from the runtime bot session,
   and never starts a canary without an explicit operator command.
3. Runtime sessions emit **typed decision proposals** only; host code validates
   and applies watchlist/ledger/decisions mutations (INV-S1/S2/S10).
4. Offline evaluation requires distinct development and holdout sealed epochs,
   path confinement, tests, safety floors, and holdout single-use.
5. Live canaries may assign a configured fraction (default 10%) of internal
   decision episodes to a candidate **policy version**. Candidate external
   effects (broadcast, router, X mutations, wallet lifecycle) are blocked.
   Baseline runs in shadow for paired comparison. Rollback means future
   assignments return to baseline; history stays append-only.
6. Promotion is **human-gated**. Host/orchestrator/audit/egress code changes
   never enter a live canary — decision-policy surfaces only.

## Consequences

- Config schema 5 adds `harness_improvement` (default `enabled: false`,
  `schedule_enabled: false`).
- CLI / job: `tc run harness-improve` and `tc harness *`.
- Scheduled path may open a GitHub PR after green worktree tests; it never
  self-merges and never enables canary.
- New invariants INV-S23–S25 cover proposal ownership, harness confinement, and
  canary egress blocking.
- Relative Strength Index remains the chart feature under `indicators.rsi_*`.

## Enforcement

- `src/orchestrator/proposals.ts`, `src/orchestrator/scorecard.ts`, `src/harness/**`
- `docs/architecture/harness-improvement.md`, INV-S23–S25
