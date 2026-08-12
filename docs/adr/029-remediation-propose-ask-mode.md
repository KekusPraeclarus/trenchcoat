---
title: "029 — Remediation propose/review sessions use ask mode"
status: accepted
date: 2026-07-23
---

# ADR 029: Remediation propose/review sessions use ask mode

## Context

After ADR 027 unblocked the incident-remediation lane from `agent/.lock`
starvation, Discord suggestion incidents still failed at propose with
`propose:session failed`: Cursor `plan`-mode sessions returned empty / unfinished
output on the VPS (including after switching `propose_model` to
`composer-2.5-fast`). Diagnose (already ask) succeeded; propose did not.

Propose and review agents only need structured JSON (patch proposal / review
decision). They do not need plan-mode writer semantics — the build step mutates
in an isolated worktree under the repo mutation lock.

## Decision

1. Run remediation diagnose, propose, pre-review, and related read-only Cursor
   sessions with `mode: "ask"` (see `src/remediation/agents.ts`).
2. Keep `propose_model` / `build_model` as model-id knobs only — mode is not
   configurable; ask is mandatory for those read-only stages.
3. Treat `propose:session failed` as infrastructure; treat `pre-review-reject`
   as a product rejection of the proposed patch (retry may reproduce it).

## Consequences

- Propose completes reliably enough to reach pre-review / approval / build.
- CONFIG docs must not describe propose as a "plan" session.
- Operators debugging stuck suggestions should distinguish session failure from
  pre-review reject before burning retries.

## Alternatives considered

- Keep plan mode and raise session timeouts — still saw empty plan sessions.
- Force a specific propose model only — model change alone did not fix plan
  sessions on the VPS.
- Skip pre-review after propose — weakens INV-S27 gates.

## Follow-ups

- Ask-mode change shipped in `7bba58a`.
- Host truncates verbose proposal string fields on parse (`summary`/`rollout`/
  `rollback`/`notViableReason` ≤500; `invariants`/`smokeChecks` ≤64); propose
  prompt states those bounds.
- On retry after `pre-review-reject` / `revise`, propose receives
  `priorPreReviewPath` (existing `pre-review.json`) and must address every
  concern or set `viable=false` — blind retries without that feedback loop
  reproduced the same reject.
- Host auto-loops `revise` → propose up to `max_pre_review_revises` (default 5)
  inside one worker run. `reject` and revise-exhausted still fail closed for the
  operator.
