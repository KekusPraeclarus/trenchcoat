---
title: "026 — Daily Telegram digest and topic-only intraday posts"
status: accepted
date: 2026-07-22
last_verified: 2026-08-31
---

# ADR 026: Daily Telegram digest and topic-only intraday posts

## Context

Shared agent outbox → ingest → `renderChannelPayloads` ran Telegram's landscape
overview **per staged item** on the full chat report. Multiple same-run events
therefore produced reworded versions of the whole narrative board. Discord
later copies the same Telegram leader text (ADR 041). The older "one Discord
payload per run" rule no longer applies.

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
   development in the prior 04:00→04:00 London window. Quiet active narratives
   are omitted — absence is the signal; never pad with "no development" filler.
   One paragraph per section; host may deliver across multiple Telegram
   messages without page labels but never splits a section. Immutable ledger at
   `archive/telegram-digests/<London-date>.json`. Day-keyed
   `eventId`; retries reuse the exact stored event. No active narratives, or
   active but no window developments → durable no-send record.

Worthiness history is subject-scoped for 48h and includes accepted **plus**
still-staged candidates. Reworded same-catalyst rejects; genuinely new
same-subject developments remain eligible. Outbox envelopes are capped at eight
items per run.

> **Update (ADR 041):** Discord forwards the same rendered text as Telegram.
> Digest window anchor is 04:00 Europe/London.
>
> **Update (ADR 049):** 8000 characters is a distiller target only. Longer
> maps still send. The host also sends a raw `.md` file to the operator
> interface bot only. The public channel never receives that file.

## Consequences

- Config schema 18 adds `broadcast.telegram_digest.enabled` (default false; seed true).
- New router type `narrative.digest` (not broadcast/correction).
- INV-B2 documents topic grouping, staged-history worthiness, and the daily ledger.
- Agent skills: one `BroadcastItem` per subject per run (host grouping is authoritative).
