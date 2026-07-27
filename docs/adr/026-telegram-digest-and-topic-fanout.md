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
   message is a **single-topic short paragraph** (≤800 Markdown characters;
   Discord-style closer with room for one paragraph — no multi-section briefings).
   Events are grouped by normalized `auditClaim.subject`; one leader per group
   receives Telegram (`urgent` > `notable` > `watch`, then smallest `eventId`);
   followers omit `channels.telegram` (`topic-merged`). Distiller input is a
   bounded host packet only (never `reports/chat` or unrelated narratives).
   Config key `broadcast.telegram_overview` is preserved for live continuity;
   internal intent is a short topic update.
2. **Daily** — one host-only `telegram-digest` job at **04:00 Europe/London**
   (VPS systemd calendar timer only; was 20:00 before ADR 041). Emits a Telegram-only `narrative.digest`
   covering retention-active narratives that had a host-approved Telegram
   development in the prior 20:00→20:00 London window. Quiet active narratives
   are omitted — absence is the signal; never pad with "no development" filler.
   Immutable ledger at `archive/telegram-digests/<London-date>.json`. Day-keyed
   `eventId`; retries reuse the exact stored event. No active narratives, or
   active but no window developments → durable no-send record. Listed
   development headers alone over capacity → `capacity-exceeded`, run incident,
   failed job (never silent truncate or split).

Worthiness history is subject-scoped for 48h and includes accepted **plus**
still-staged candidates. Reworded same-catalyst rejects; genuinely new
same-subject developments remain eligible. Outbox envelopes are capped at eight
items per run.

Discord behavior is unchanged.

> **Update (ADR 041):** Discord now forwards the same rendered text as Telegram.
> Digest window anchor moved to 04:00 Europe/London.

## Consequences

- Config schema 18 adds `broadcast.telegram_digest.enabled` (default false; seed true).
- New router type `narrative.digest` (not broadcast/correction).
- INV-B2 documents topic grouping, staged-history worthiness, and the daily ledger.
- Agent skills: one `BroadcastItem` per subject per run (host grouping is authoritative).
