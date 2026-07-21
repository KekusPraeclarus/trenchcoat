---
description: ADR — Discord research bot is Gateway-isolated from router webhook broadcasts and main agent state.
scope: project
status: accepted
last_verified: 2026-07-21
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
  queue, INDEX, outbox, and Telegram paths.
- Discord watchlist: subscribe every completed research token (except scanner
  hard-fail) for member updates — independent of model verdict.
- Main watchlist: host-only `promoteDiscordTrackToMain` may apply a validated
  `track` proposal onto `~/.trenchcoat/agent` (INV-S9/S23). Replies never mention
  either list.
- Config schema **10**: `chat.discord.*` caps and channel allowlist.
- Isolation invariant: **INV-D1** (with the bounded host-promote exception).
- Unknown exact `slug:address` may enqueue host chain integration (ADR 016 /
  INV-D2) — still not a Discord agent mutation path.

## Consequences

- Two tokens, two processes, two state trees — docs and ops must never conflate
  “Discord webhook” with “Discord research bot”.
- Discord research caps were independent of main `research.daily_cap` and router
  Discord broadcast budget; schema 16 / ADR 022 later **removed** Discord
  intake caps (FIFO + tracking / chain-integration caps remain).
- Skills under `~/.trenchcoat/discord/agent/skills/` are copied on first run;
  redeploy code does not auto-sync them (same class of gotcha as Telegram runtime
  skills).
- Live canaries require explicit `TRENCHCOAT_LIVE_DISCORD=1` (see plan §14).
- Watch update voice and fallback contract: ADR 012.
- Idea-tracking (NL watch-for-ideas, durable match batches, gated alerts):
  ADR 018 / ADR 019 / INV-D3–D8.
- Channel conversation over main workspace (addressing gate, unconfirmed
  research + synthesis, Discord intake caps removed): ADR 022 / INV-D9.
- Main promote is best-effort: if main `.lock` is busy, Discord subscribe still
  succeeds and promote is skipped (logged).

## References

- [architecture/discord-research.md](../architecture/discord-research.md)
- [knowledge/discord.md](../knowledge/discord.md)
- INV-D1 in [INVARIANTS.md](../INVARIANTS.md)
