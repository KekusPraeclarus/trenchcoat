---
description: ADR — Agent-proposed, host-enforced narrative framing maturity; stable slug; stale lane-rotation reject.
scope: project
status: accepted
date: 2026-07-24
last_verified: 2026-07-24
supersedes: []
---

# ADR 036 — Durable narrative framing maturity

## Context

Long-running lanes (notably Robinhood-chain / `rh-chain-meme-rotation`) kept
being called a “rotation” in titles, deslug labels, host distill prompts, and
outbox copy long after they had become durable ecosystem/infra behaviour.
Status-quo stage gates already suppressed unchanged heat restatements, but they
did not retire stale **framing** vocabulary. Baking “rotation” into the stable
slug made mechanical deslug (`RH Chain Meme Rotation`) perpetuate the problem
even when the agent wrote better prose.

Operator intent: notice durability, stop calling the lane a rotation, keep
history joinable on the same subject id, and fail closed if egress still uses
lane-“rotation” wording. Do not backfill prior Telegram/Discord messages.

## Decision

1. **Hybrid maturity.** The agent proposes framing changes in
   `reports/<run-id>/narrative-proposals.jsonl`. The host schema-validates,
   merges into integrity-protected `state/narratives/log.jsonl`, and enforces
   egress. Time alone is insufficient; multi-run observation plus same-run
   evidence of durable ecosystem/infra/product delivery or ongoing usage is
   required (skill rubric).

2. **Framing enum.** Optional `framing: rotation | ecosystem | regime`
   (omit = `rotation`). Mature entries require `framingMaturedAt` and
   `framingEvidence` (≥1 provenance id) and a title that does **not** match
   `\brotation\b`. Merge is **monotonic**: never regress `ecosystem`/`regime`
   → `rotation`; first `framingMaturedAt` wins on conflicts.

3. **Stable slug.** Subject / dedupe / claim-index identity stays kebab forever
   (e.g. `rh-chain-meme-rotation`). Only `title`, preferred display labels, and
   outgoing prose change.

4. **Preferred labels.** `preferredNarrativeLabel` prefers the validated title
   when framing is mature (and may prefer a rotation-free title when the slug
   still embeds `rotation`). Channel render, distill packets, digests, and INDEX
   mature lines use that label; residual kebab scrub still uses mechanical
   deslug.

5. **Fail-closed egress.** `usesStaleRotationFraming` rejects outbox `text`
   (and distill post-checks) that mention a matured lane alias together with
   `\brotation\b`, or that contain the mechanical deslug of a matured slug.
   Reject reason: `stale-narrative-framing`. The host never rewrites agent
   market text (INV-B2).

6. **Display framing ≠ claim type.** Capital-flow `auditClaim.type: "rotation"`
   / `verificationRule: "rotation"` and development `direction: "rotation"`
   remain category/attention-shift semantics. They do not authorize naming a
   matured lane “the RH rotation” in `text`.

## Consequences

- Operators get ecosystem/regime language once the agent has evidence; history
  and novelty dedupe stay on the original slug.
- Agents that keep saying “RH rotation” after maturity get a typed reject
  receipt instead of a silent rephrase.
- Prompt examples and skills must stay framing-aware or distill models will
  reintroduce stale wording (post-checks catch Discord/Telegram rewrites).
- No slug migration, no auto time-based maturity cron, no config toggle, no
  backfill of prior fanout.

## Alternatives considered

- **Prompt-only guidance** — rejected; status-quo heat gates already showed
  skill compliance alone is insufficient for egress.
- **Time-threshold auto-maturity** — rejected; calendar age without ecosystem
  evidence is not durability.
- **Slug rename / history migration** — rejected; breaks claim index, 48h
  development dedupe, and archive subject identity.
- **Host scrub of “rotation” in channel copy** — rejected; INV-B2 forbids the
  host inventing market text.
- **Fold only into ADR 023** — rejected for a dedicated ADR; 023 remains
  same-stage development / worthiness / research-outbox; this ADR owns framing
  lifecycle.

## Follow-ups

- Optional: surface `stale-narrative-framing` counts in chat digest / health.
- Live RH log matures on the next production `narrative-scan` after deploy
  (no offline rewrite of live `log.jsonl` in this change).

## Related

- Extends [ADR 023](023-narrative-development-and-research-broadcast.md)
  (same-stage development path may announce framing maturity).
- INV-B2 / INV-S23; [agent-workspace.md](../architecture/agent-workspace.md);
  [orchestrator.md](../architecture/orchestrator.md); context probes P16 / P50.
