---
title: "025 — Passive Discord suggestion intake for incident remediation"
status: accepted
date: 2026-07-22
---

# ADR 025: Passive Discord suggestion intake

## Context

Operators and community members propose product fixes and small features in Discord channels. The hourly incident-remediation lane already diagnoses, builds, and deploys bounded patches under INV-S27 risk gates, but it only scanned health/logs/skips. The weekly decision-policy harness (INV-S24) must not accept Discord text.

## Decision

Extend **incident remediation** (not the policy harness) with passive, conversation-aware Discord suggestion intake:

1. Host fetches channel history since a durable per-channel cursor (GET-only, allowlisted channels).
2. Messages are grouped into threads (reply chains + 5-minute ambient windows). Bot/webhook messages are context-only; humans author candidates.
3. Reply-chain ancestors may extend context beyond the scan window; they never re-enter as fresh candidates.
4. Stage A deterministic prefilters (eligibility, early fingerprint dedupe, suggestion-signal heuristic) run before any model call. Admission needs **both** a request word and a product surface word in human text. A bare mention no longer admits a thread.
5. A path-only batch classifier returns `suggestion-formed` | `forming` | `not-buildable`. Disagreement yields the classifier's best recommendation plus alternatives/rationale — never a skip. When alternatives exist, `recommendationRationale` is required.
6. A formed suggestion must carry a testable decision: `symptom`, `intendedBehavior`, and one to five measurable `acceptanceCriteria`. A missing intended behavior downgrades to `forming`; any other gap is a classifier fault (`classifier-failed`).
7. Incomplete ideas persist as `forming` digests (7-day idle expiry, max 5 rounds) and merge across scans. The daily operator digest shows full detail for `queued`, `queued-waiting`, and `built` only, and reports forming threads as one count. A forming-only day sends no digest.
8. Extensions of previously **built** suggestions are exempt from skip-dedupe and carry `extends:` lineage into diagnose.
9. Host worth-building gates (scope, deny-surface, capacity, incident dedupe) fail closed. Capacity overflow becomes `queued-waiting`.
10. Queued items become `discord-suggestion` incidents and follow the existing remediation pipeline, including low-risk auto-build and high-risk Telegram approval. Diagnose/propose may return typed `not-viable`.

Raw Discord text never enters prompts, diffs, commit messages, or logs — only sanitized evidence paths and host-validated summaries.

## Consequences

- Config schema 17 adds `incident_remediation.discord_suggestions` (default disabled).
- Health snapshot gains structured `findings` (cadence, heartbeats, systemd units, stuck runs) consumed by remediation intake.
- Ledger at `~/.trenchcoat/remediations/suggestions.json`; CLI `tc remediations suggestions`.
- Telegram digests/failures are host-descriptive (labels + sanitized summaries), optionally polished by `composer-2.5`.
- INV-S24 unchanged. INV-S27 gains Discord-suggestion origin with the same confinement and deny surfaces.
