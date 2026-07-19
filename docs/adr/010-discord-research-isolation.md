---
description: ADR — Discord research bot is Gateway-isolated from router webhook broadcasts and main agent state.
scope: project
status: accepted
last_verified: 2026-07-19
---

# ADR 010 — Discord research isolation

## Context

Operators wanted private-guild research in Discord: natural CA requests, final-only
replies, per-user watch subscriptions, and six-hour material updates — without
coupling to the main research queue, watchlist, ledger, or broadcast router.

Discord already had a **webhook** path for market broadcasts (`DISCORD_WEBHOOK_URL`
via the in-repo router). Interactive research requires a **Gateway bot** with
Message Content intent.

## Decision

- Add a second Discord surface: `DISCORD_RESEARCH_BOT_TOKEN` + `tc listen discord`
  (discord.js Gateway). Keep `DISCORD_WEBHOOK_URL` for outbound broadcasts only.
- Root all Discord research runtime under `~/.trenchcoat/discord/` with its own
  `.lock`, separate from `agent/.lock`.
- Reuse shared collectors, chain resolution, deep-research passes, and chat-report
  promotion, but run them against `~/.trenchcoat/discord/agent/` and skip main
  queue, proposals, INDEX, outbox, and Telegram paths.
- Config schema **10**: `chat.discord.*` caps and channel allowlist.
- Isolation invariant: **INV-D1**.

## Consequences

- Two tokens, two processes, two state trees — docs and ops must never conflate
  “Discord webhook” with “Discord research bot”.
- Discord research quota is independent of main `research.daily_cap` and router
  Discord broadcast budget.
- Skills under `~/.trenchcoat/discord/agent/skills/` are copied on first run;
  redeploy code does not auto-sync them (same class of gotcha as Telegram runtime
  skills).
- Live canaries require explicit `TRENCHCOAT_LIVE_DISCORD=1` (see plan §14).

## References

- [architecture/discord-research.md](../architecture/discord-research.md)
- [knowledge/discord.md](../knowledge/discord.md)
- INV-D1 in [INVARIANTS.md](../INVARIANTS.md)
