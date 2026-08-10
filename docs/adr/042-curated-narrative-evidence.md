---
title: "042 — Curated narrative evidence"
status: accepted
date: 2026-08-10
last_verified: 2026-08-10
---

# ADR 042: Curated narrative evidence

## Context

`narrative-scan` copied every sealed social item into the derived
`narrative-social-*` snapshots. One promotional thread, one cross-posted
duplicate, or a single loud account was enough to look like a narrative. The
agent then proposed `narrative-emergence` or `rotation` claims with no
independent support, and the host had no deterministic reason to refuse them.

## Decision

1. **Host-side curation.** `curateSocialEvidence`
   (`src/orchestrator/social-evidence.ts`) filters the derived snapshots only.
   Exclusion reasons are `collector-status`, `expired`, `duplicate`,
   `promotion-pattern`, and `repeated-promotion`. Deduplication uses
   `dedupeKey`, then URL, then a normalized text hash, across all social sources
   in one pass, so a cross-posted item counts once.
2. **Raw archives stay whole.** Curation never touches sealed collector runs.
   `archive/runs/<runId>/inbox/*` remains byte-identical.
3. **Quality tiers.** `assessNarrativeEvidenceQuality`
   (`src/orchestrator/narrative-evidence-gate.ts`) grades the curated set as
   `strong`, `limited`, or `none`. `strong` needs at least
   `min_fresh_posts` eligible posts, at least `min_independent_authors`
   authors, and a promotional share at or below `max_promotional_share`.
   `primary_source_handles` records an extra signal; it never replaces the
   author floor.
4. **Claim gate.** `ingestOutbox` rejects `narrative-emergence`,
   `narrative-fade`, `narrative-development`, `rotation`, and
   `sentiment-collapse` unless the tier is `strong`. The reject reason is
   `narrative-evidence-quality:<first failing floor>`. Token and wallet claims
   keep their existing market gates.
5. **Visible grade.** The scan writes `narrative-evidence-quality` into the run
   inbox, so the agent reads the same grade the host gates on. Limited evidence
   stays visible with an explicit status instead of disappearing.
6. **Config.** Schema 23 adds `narratives.evidence_quality`
   (`enabled`, `max_promotional_share`, `min_independent_authors`,
   `min_fresh_posts`, `primary_source_handles`).

## Consequences

- A single-author or promotional day produces no narrative broadcast.
- Every rejection is deterministic and carries an archived receipt.
- Operators tune floors in config; no model call takes part in curation.
- Back-tests over raw archives stay valid, because raw files do not change.

## Related

- [ADR 041](041-unified-broadcast-fanout.md)
- [docs/architecture/collectors.md](../architecture/collectors.md)
- [docs/architecture/orchestrator.md](../architecture/orchestrator.md)
- `INV-B2`
