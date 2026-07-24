---
description: ADR — Bounded shadow improver-config lane with paired offline meta-utility and operator-only promotion.
status: accepted
date: 2026-07-24
last_verified: 2026-07-24
---

# ADR 039 — Bounded improver-config lane

## Context

ADR 038 deferred autonomous improver self-edit until a follow-up ADR defined
schema, meta-utility, and an immutable outer shell. The policy lane
(ADR 005) now needs weakness mining, manifesto, keep summaries, and
prior-attempt memory; those improvements also make a **second**, narrowly
confined surface useful: `config/harness-improver.json` knobs that steer
propose/mining strategy without touching evaluator code or gates.

## Decision

1. **Second editable surface.** Autonomous meta-lane patches are confined to
   the literal path `config/harness-improver.json`. It is repo-owned host
   configuration, never synced into `agent/`, and cannot contain paths,
   commands, models, floors, evaluator settings, allowlists, or executable
   expressions. Unknown keys fail closed.
2. **Immutable outer shell.** Neither policy nor meta lane may edit
   `src/harness/**`, `src/contracts/**`, host prompts that define gates,
   audit/outcome code, test fixtures, protected metrics, safety floors,
   holdout/meta-trial registries, confinement, allowlist constants,
   deployment, scheduling, or secrets.
3. **Shadow-only until promotion.** Meta candidates never integrate, deploy,
   activate the agent workspace, start a live canary, or affect policy
   proposals until operator promotion. Default runtime reads the checked-in
   baseline (or last promoted) config.
4. **Paired offline trials.** Each meta trial selects one new development
   epoch and one new holdout epoch. Baseline and candidate improvers each
   produce one policy candidate from identical sealed inputs; both are
   evaluated on that holdout; the holdout is then atomically marked consumed
   by the trial and cannot be reused by policy or later meta trials.
5. **Host-owned meta-utility (non-configurable).** A candidate becomes
   `promotion_eligible` only when: ≥8 valid pairs; candidate ≥5 wins;
   candidate win rate > baseline; candidate protected-regression and
   invalid-candidate counts are no worse; median signed primary improvement
   is positive and no worse than baseline; no safety/integrity failure.
   Ties count for neither side. Utility weights and bounds are code
   constants, not config knobs.
6. **Operator-only promotion.** `promotion_eligible` is not activation.
   `tc harness meta promote` revalidates cleanliness, candidate hash, eight
   trial receipts, utility, confinement, and independent review, then
   ff-only integrates/deploys. Revert is normal git revert + redeploy.
7. **Mutual exclusion.** At most one policy or meta experiment runs under
   the harness lock and `repo-mutation.lock`.
8. **Cadence.** Meta schedule defaults monthly (`meta_schedule_days: 30`)
   and may wake when a new eligible epoch pair appears; locking + trial IDs
   make duplicate wakeups no-ops.
9. **Schema bounds (closed).** `minClusterSize` 3–20, `maxClusters` 1–8,
   `maxKeepPatterns` 1–3, `maxEvidencePerPattern` 1–32, closed metric
   priority keys, known signal-prefix allowlist only, plan addendum ≤500
   chars.

## Consequences

- INV-S24 names both literal allowlists and cites this ADR.
- ADR 038 §4 is implemented by this ADR (not superseded).
- ADR 005 remains the policy-loop ADR; this adds a separately confined lane.
- Config schema gains meta operator controls only; utility/bounds stay in
  code.
- Job/CLI: `harness-meta-improve`, `tc harness meta propose|trial|status|promote|reject`.
- First transition to `promotion_eligible` sends a one-shot Telegram operator
  briefing (host-built; idempotent via `operator-notify.json`) with review /
  promote / reject commands — eligibility still never auto-activates.

## Alternatives considered

- **Auto-activate before eight pairs** — rejected (sample starvation /
  reward hacking).
- **Put improver config under `agent/`** — rejected (must not sync into
  runtime agent workspace).
- **Let config edit floors / test_command / models** — rejected (evaluator
  shell must stay immutable).
- **Reuse policy holdouts for meta grading** — rejected; paired protocol
  consumes a fresh holdout after both candidates are frozen.

## Follow-ups

- Wire decision outcome settlement so mining/replay have numeric evidence.
- Hand-ship mining, manifesto, keep summaries, prior-attempts on the policy
  lane in the same change set.
- Live acceptance: one shadow meta trial only; never promote in automated
  verification.
