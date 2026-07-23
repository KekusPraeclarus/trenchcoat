---
title: "026 — Daily Telegram digest and topic-only intraday posts"
status: accepted
date: 2026-07-22
---

# ADR 026: Daily Telegram digest and topic-only intraday posts

## Context

Shared agent outbox → ingest → `renderChannelPayloads` ran Telegram's landscape
overview **per staged item** on the full chat report. Multiple same-run events
therefore produced reworded versions of the whole narrative board. Discord already
attached at most one payload per run, so it looked fine while Telegram repeated.

Cross-run worthiness history only considered accepted router ingress, so a second
job could pass before the first reached that state and stage a semantic duplicate.

## Decision

Telegram has two independent output modes:

1. **Intraday** — keep immediate posts for host-approved developments, but each
   message is a **single-topic deep-dive** (≤3,400 Markdown characters). Events
   are grouped by normalized `auditClaim.subject`; one leader per group receives
   Telegram (`urgent` > `notable` > `watch`, then smallest `eventId`); followers
   omit `channels.telegram` (`topic-merged`). Distiller input is a bounded host
   packet only (never `reports/chat` or unrelated narratives). Config key
   `broadcast.telegram_overview` is preserved for live continuity; internal
   intent is topic deep-dive.
2. **Daily** — one host-only `telegram-digest` job at **20:00 Europe/London**
   (VPS systemd calendar timer only). Emits a Telegram-only `narrative.digest`
   covering **every** retention-active narrative (`pruneNarrativeLogInMemory`
   with `narratives.retention_days`). Immutable ledger at
   `archive/telegram-digests/<London-date>.json`. Day-keyed `eventId`; retries
   reuse the exact stored event. No active narratives → durable no-send record.
   Mandatory headers alone over capacity → `capacity-exceeded`, run incident,
   failed job (never silent omit or split).

Worthiness history is subject-scoped for 48h and includes accepted **plus**
still-staged candidates. Reworded same-catalyst rejects; genuinely new
same-subject developments remain eligible. Outbox envelopes are capped at eight
items per run.

Discord behavior is unchanged.

## Consequences

- Config schema 18 adds `broadcast.telegram_digest.enabled` (default false; seed true).
- New router type `narrative.digest` (not broadcast/correction).
- INV-B2 documents topic grouping, staged-history worthiness, and the daily ledger.
- Agent skills: one `BroadcastItem` per subject per run (host grouping is authoritative).
