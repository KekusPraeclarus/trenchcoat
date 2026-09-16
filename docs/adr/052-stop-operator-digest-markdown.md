---
title: "052 — Stop operator digest markdown fanout"
status: accepted
date: 2026-09-15
last_verified: 2026-09-15
---

# ADR 052: Stop operator digest markdown fanout

## Context

ADR 049 sent `daily-narrative-map-<date>.md` to the operator interface bot.
The public channel already receives the same map as section-aware text.

The operator no longer uses the file. The file arrives in the same chat as
operator notices. An X session hold DM was missed for that reason.

## Decision

1. `telegram-digest` does not send a file to the operator bot.
2. Channel `narrative.digest` posts stay. Section-aware chunks stay.
3. ADR 049 length rules stay. The distiller aims for 8000 characters.
   Longer maps still send to the channel.
4. Old `archive/telegram-digests/<date>.operator-md.json` receipts stay on
   disk. The host does not send them again.

## Consequences

- Operator chat no longer receives the daily map file.
- Auth warnings stay easier to see in that chat.
- Channel summaries do not change.

## Related

- Amends [ADR 049](049-digest-length-target-and-md-fanout.md)
- Amends INV-B2 in [INVARIANTS.md](../INVARIANTS.md)
