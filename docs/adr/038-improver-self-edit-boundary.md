---
description: ADR — Improver may not edit harness code; optional future improver-config surface only; prefer hand-shipped improver upgrades first.
status: accepted
date: 2026-07-24
last_verified: 2026-07-24
---

# ADR 038 — Improver self-edit vs decision-policy edit

## Context

ADR 005 confines autonomous harness improvement to
`agent/skills/decision-policy/policy.json` (INV-S24). Lilian Weng's harness-RSI
survey and STOP / Meta-Harness / DGM raise a sharper question: should the
**self-improvement loop improve itself** (propose heuristics, plan prompts,
meta-search strategy) rather than — or in addition to — improving decision
policy or the broader agent runtime?

Three layers are easy to conflate:

1. **Agent runtime harness** — sandbox, skills, collectors, router (not an
   autonomous mutation target).
2. **Decision policy** — `policy.json`; today's sole autonomous editable
   surface (ADR 005).
3. **Improvement loop / improver** — `src/harness/**`, host prompts, holdout
   gates, canary rules; the machinery that proposes and grades (1)/(2).

## Decision

1. **Do not** let the autonomous loop edit layer 3 **code or gates**
   (`src/harness/**`, confinement, holdout registry, protected-metric
   enforcement, allowlist constants, install/deploy, or host prompts that
   define those boundaries). That is Meta-Harness / DGM-class RSI and remains
   forbidden under INV-S24 — reward hacking and gate deletion are too cheap.
2. **Keep** layer 2 (`policy.json`) as the default autonomous optimization
   target. Improving *how well the agent decides* is the product goal; the
   improver exists to serve that.
3. **Prefer** human-authored (or normal PR) upgrades to the improver first —
   weakness mining, edit manifesto, keep-examples, negative-result index
   ([harness-self-improvement-patterns.md](../knowledge/harness-self-improvement-patterns.md)).
   Those are STOP-style improver improvements without giving the loop a
   self-edit surface.
4. **Second bounded artifact** — implemented by
   [ADR 039](039-bounded-improver-config-lane.md): schema-validated
   `config/harness-improver.json` (metric/priority weights, mining knobs,
   length-capped plan addenda) under a *stricter* shadow pipeline graded by
   host-owned **meta-utility** over paired offline trials. That config must
   **not** loosen floors, expand allowlists, skip holdout, or edit its own
   evaluator. Cadence slower than weekly policy experiments; promotion is
   operator-only after ≥8 pairs.
5. ADR 005 is **not** superseded; this ADR narrows interpretation of
   “harness self-improvement”. ADR 039 authorizes the bounded config lane
   without allowing Meta-Harness/DGM on improver code.

## Consequences

- Sessions must not treat “improve the improver” as license to mutate
  `src/harness/**` or widen allowlists beyond the literals in INV-S24 /
  ADR 039.
- Policy-lane mining/manifesto/keep/prior-attempts land as hand-shipped
  host code; the meta lane only edits `config/harness-improver.json`.
- Meta-utility remains sample-hungry; shadow-only until operator promotion.

## Alternatives considered

- **Full Meta-Harness / DGM on `src/harness/**`** — rejected (INV-S24,
  reward hacking, auditability).
- **Stop improving policy; only evolve improver** — rejected; product value
  is decision quality.
- **Ship improver-config without a follow-up ADR** — rejected; ADR 039
  records the schema, utility, and shell before any allowlist widen.

## Follow-ups

- Policy-lane weakness mining + manifesto + keep + prior-attempts (same
  change set as ADR 039).
- Live acceptance: shadow meta trial only; never auto-promote.
