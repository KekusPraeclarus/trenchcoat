---
description: ADR — Same-stage narrative developments route through novelty dedupe; worthiness uses accepted delivery history; resolved research must propose one broadcast.
scope: project
status: accepted
last_verified: 2026-07-22
---

# ADR 023 — Narrative development routing and mandatory research broadcast

## Context

Live audit (2026-07-21/22) showed three independent gaps between operator
expectation and host behaviour:

1. **Same-stage narrative updates were hard-rejected.** Agents often emit
   `narrative-emergence` or `rotation` for a slug whose stage did not change
   (e.g. PONS CEO follow, stockcoin heat, Jimothy ATH). `assertNarrativeBroadcastAllowed`
   returned `narrative-unchanged-stage` before worthiness or development dedupe,
   so notable catalysts never reached Telegram/Discord even when the text carried
   new facts.

2. **Worthiness inferred prior delivery from the wrong evidence.** The
   `composer-2.5-fast` gate sometimes rejected proposals with reasons like
   "already broadcast today on CEO follow" when no accepted router delivery
   existed — the model conflated status-quo narrative state and untrusted agent
   notes with confirmed fanout.

3. **Research treated operator notification as optional.** Completed resolved
   dossiers (SCG, TENDIES, NILF) finished with `staged: 0` because the agent
   wrote no `outbox/<run-id>.json`, used invalid verdict tokens (`pass`, `watch`),
   or assumed chat recall was enough. ADR 015 required research outbox for the
   telegram-alpha bridge but the general `research` job still treated broadcast
   as skippable guidance.

Operator intent: notable same-narrative developments should broadcast when they
carry new salient facts; exact repeats of recently delivered claims should not;
research conclusions (positive or negative) should reach the operator channels
when identity is resolved and the dossier supports a bounded takeaway. No
backfill of missed sends.

## Decision

### Same-stage narrative compatibility routing

- When `assertNarrativeBroadcastAllowed` sees `narrative-emergence` or
  `rotation` on a slug whose stage is unchanged, return `{ ok: true,
  sameStageDevelopment: true }` instead of `narrative-unchanged-stage`.
- `ingestOutbox` routes those items through `assertNarrativeDevelopmentAllowed`
  (`narrative-development.ts`) with `sameStageDevelopment: true`, treating legacy
  emergence claims like development broadcasts for novelty purposes.
- Pure status-quo restatements remain rejected via `restatesUnchangedNarrativeStage`
  and development repeat checks. Development dedupe compares salient tokens against
  **accepted** prior claims in a 48h window (`extractBroadcastClaimsFromArchive`
  with `acceptedOnly: true`), not an in-memory index alone.
- `narrative-development` remains the preferred claim type for within-narrative
  updates; compatibility routing exists because agents still mislabel catalysts
  as emergence/rotation.

### Worthiness uses accepted delivery history only

- Before worthiness review, the host loads recent accepted `finding.broadcast`
  router receipts from the archive and passes them as trusted
  `<accepted-broadcast-history>` in the worthiness prompt (extends ADR 014).
- Only that list may support an "already broadcast" / repeat rejection.
  Status-quo narrative stages and untrusted agent notes are context, not delivery
  proof.
- Completed resolved research with a clear trade, watch, or avoid takeaway is
  explicitly worthy even when the conclusion is negative.

### Mandatory research outbox

- The `research` job prompt and skills require exactly one
  `outbox/<run-id>.json` item for every completed resolved dossier with a clear
  operator takeaway, using `token-up` or `token-down` severity as appropriate.
- Omit outbox only when identity is unresolved/ambiguous or evidence cannot
  support even a bounded trade, watch, or avoid conclusion.
- `decision-proposals.json` verdict must be exactly `track|drop|ignore|revisit`;
  invalid tokens (`watch`, `pass`, …) fail proposal load and downstream Discord
  subscribe/tracking gates (`verdict-missing`).
- Host worthiness, schema validation, and Discord budget still gate fanout;
  the host never invents market text (INV-B2).

## Consequences

- Notable same-stage narrative catalysts (revenue, leaders, tape, identity
  risks) can reach operators without forcing a stage transition or retagging
  every claim as `narrative-development`.
- Repeat suppression is anchored to confirmed deliveries, reducing false
  "already sent" worthiness rejects.
- Research runs with resolved identity and a clear conclusion will always
  produce a broadcast proposal; silent completion without outbox becomes a
  prompt/skill violation rather than an accepted path.
- Worthiness and development dedupe add archive reads on ingest; cost is bounded
  by a short recent window.
- Does **not** backfill missed broadcasts from the audit window; only forward
  behaviour changes.
- Does **not** change ADR 021 Discord watch subscribe gates or ADR 019 tracking
  alert rules — separate incident class (pre-gate watch subs with invalid verdicts).

## Alternatives considered

- **Require agents to always use `narrative-development` for same-stage updates**
  — rejected; skill compliance alone did not prevent misclassified emergence
  claims; host compatibility routing is more reliable.
- **Keep hard `narrative-unchanged-stage` and loosen worthiness only** — rejected;
  would still drop valid proposals before worthiness ran.
- **Infer repeat history from staged-but-not-delivered proposals** — rejected;
  would have blocked Venice-style sends after false "already broadcast" rejects.
- **Host-authored research broadcast text when agent omits outbox** — rejected;
  violates INV-B2 authorship; mandatory agent outbox preserves audit trail.

## Follow-ups

- Optional: surface `broadcast-rejects.json` reasons in chat digest breakdowns
  so operators can distinguish proposals from confirmed fanout without archive
  scripts.
- Optional: metric on research runs completing without outbox despite resolved
  identity (host-side lint after seal).

## Related

- Extends [ADR 014](014-broadcast-worthiness.md) (accepted-history worthiness).
- Aligns general `research` with [ADR 015](015-telegram-alpha-research.md)
  outbox requirement.
- INV-B2 updated to codify same-stage development routing and mandatory
  research broadcast.
- Founder primary-source catalysts: [ADR 024](024-founder-primary-source-broadcast.md).
