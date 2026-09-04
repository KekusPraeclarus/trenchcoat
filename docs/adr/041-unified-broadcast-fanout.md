---
title: "041 — Unified Telegram/Discord broadcast fanout"
status: accepted
date: 2026-07-27
last_verified: 2026-09-04
---

# ADR 041: Unified Telegram/Discord broadcast fanout

## Context

Telegram and Discord each had a separate channel-render path: topic distiller on
Telegram, chat-report distiller plus daily message budget on Discord. Operators
received the same signal twice with different wording and paid two LLM sessions
per run.

## Decision

1. **Intraday `finding.broadcast`:** keep the Telegram topic render path only.
   When `channels.telegram` is set, copy the same string to `channels.discord`
   and build a structured `channels.grok` twin. Topic-merged followers omit
   Telegram, Discord, and Grok. Grok is optional and needs both intake env
   vars. A Grok failure does not fail Telegram or Discord.
2. **Remove** Discord message budget (`daily_budget` / `urgent_ceiling`), Discord
   distiller LLM, run-scoped Discord dedupe, and `broadcast-ledger` reservation.
3. **Config schema 22** drops the removed keys. `DEPLOYMENT_CONFIG_SCHEMA` bumps
   to 22.
4. **Topic distill session counter** file renames to
   `archive/broadcast-budget/topic-distill-<UTC-day>.json` (legacy
   `discord-distill-*` still read for the same day).
5. **Daily digest** stays Telegram-only (`narrative.digest`). Window anchor moves
   from 20:00 to **04:00 Europe/London** (VPS systemd timer).

## Consequences

- Discord research bot flows are unchanged.
- Hot-day `llm_budget_fraction` applies to `telegram_overview` only.
- ADR 033 Discord message-lane sections are historical; LLM cap guidance for
  `telegram_overview` remains.
- Operators must refresh VPS systemd after deploy for the new digest timer.
- Grok intake stays off unless `INTAKE_WEBHOOK_URL` and `INTAKE_SENDER_KEY`
  are both set. Rotate the sender key in the Grok Bot panel, then restart
  the router.

## Related

- Supersedes Discord-lane fanout in [ADR 033](033-hot-day-broadcast-lane-budgets.md)
- Amends digest schedule in [ADR 026](026-telegram-digest-and-topic-fanout.md)
