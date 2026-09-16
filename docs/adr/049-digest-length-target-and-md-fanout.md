---
title: "049 — Daily digest length target and raw markdown fanout"
status: accepted
date: 2026-08-26
last_verified: 2026-09-15
---

# ADR 049: Daily digest length target and raw markdown fanout

## Context

On 2026-08-26 the 04:00 London `telegram-digest` job prepared a 9881-character
map and then failed at `Outbox.stage`. `RouterEvent.text` had a hard 8000
character cap. The ledger stored `outcome=prepared`. Telegram received nothing.

The same cap blocked 7 Aug, 8 Aug, and 19 Aug. INV-B2 also said overflow must
fail audibly. That rule dropped the daily map.

Operators also want the raw markdown on the interface bot, not only the
chunked channel posts.

## Decision

1. **8000 is a prompt target.** The daily digest distiller aims for an
   assembled map near 8000 characters. It must not drop a required section to
   hit that size.
2. **Length is not a send gate.** `RouterEvent.text` and channel payloads use
   `ROUTER_EVENT_TEXT_MAX` as a transport bound only. Stage and fanout must
   not reject a digest because it is longer than 8000 characters.
3. **Raw markdown fanout (amended by ADR 052).** The host no longer sends
   `daily-narrative-map-<activity-date>.md` to the operator interface bot.
   Channel fanout stays section-aware text chunks only.
4. Historical receipts may remain at
   `archive/telegram-digests/<date>.operator-md.json`. The host does not send
   from them.
5. **Markdown shape.** Host render uses
   `**Daily narrative map — YYYY-MM-DD** _(AI)_`, then `**Label**` flush to
   the body. Headers omit the stage suffix. Blank lines stay between
   sections only. Channel text uses this shape.

## Consequences

- Existing ledger events longer than 8000 characters can stage on retry.
- Channel posts stay section-aware multi-message delivery and never include a
  raw `.md` attachment. ADR 052 also stops the operator `.md` file.
- INV-B2 no longer treats digest overflow as a hard fail.

## Related

- Amends [ADR 026](026-telegram-digest-and-topic-fanout.md)
- Amends INV-B2 in [INVARIANTS.md](../INVARIANTS.md)
- Amended by [ADR 052](052-stop-operator-digest-markdown.md)
