---
title: "045 — Narrative dossiers"
status: accepted
date: 2026-08-10
last_verified: 2026-08-10
---

# ADR 045: Narrative dossiers

## Context

Narrative memory was a structured log only: `state/narratives/log.jsonl`
carries slug, title, stage, framing, tickers, and evidence pointers, and the
host prunes any slug quiet for `narratives.retention_days` (14). A recurring
meta (AI, RWA, cat coins) that fades and returns therefore started from zero:
no prose about what the narrative is, what already happened, or what the
system already broadcast. Tokens have long had this layer
(`state/research/<token>.md`, curated by review); production showed zero
narrative prose files after three weeks live because no skill instructed any
job to write them.

## Decision

1. **Per-slug dossier.** `state/narratives/<slug>.md` is the agent-curated
   prose memory for a narrative. narrative-scan creates or updates it only on
   broadcast triggers (new slug with substance, stage change, notable concrete
   development, founder primary-source catalyst) — never on pure re-sightings.
   Frontmatter: `title`, `stage`, `framing`, `status: active|dormant`,
   `last_verified`. Body: compressed notes with provenance ids, ~2k-token
   budget. review distils oversized dossiers.
2. **Dormancy survives the log prune.** When `pruneNarrativeLog` drops a slug,
   the host sets the dossier's frontmatter to `status: dormant`
   (`markNarrativeDossierDormant`) and keeps the body. Slugs are stable
   forever, so a returning narrative reads its dormant dossier and flips it
   back to `active`.
3. **Bounded lifetime.** Workspace retention deletes dossiers untouched past
   `retention.narrative_dossier_days` (config schema 25, default 120) whose
   slug is absent from the log. Dossiers of active slugs survive at any age.
   `log.jsonl` never matches the sweep.
4. **Read path.** The broadcast checklist and narrative-scan read the subject's
   dossier before writing copy, and dossiers are valid outbox `refs`. INDEX
   narrative lines already point at the dossier when it exists.

## Consequences

- The log stays authoritative for stage and freshness; the dossier never
  substitutes for a proposal line.
- The dossier is agent-written prose downstream of scraped text — same trust
  class as `state/research/<token>.md`; host state and INDEX stay host-owned.
- Host dormant-marking is the one place the host edits agent prose; it only
  rewrites the `status:` frontmatter line and preserves the body
  byte-for-byte.
- Skill edits require a skills sync to the live agent home before live jobs
  pick them up.
