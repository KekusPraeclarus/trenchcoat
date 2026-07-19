---
description: Provider knowledge — Discord webhook fanout (router) and Gateway research bot (isolated).
scope: project
status: active
last_verified: 2026-07-19
---

# Discord

## Broadcast webhook (router)

- Router-only webhook delivery with `wait=true`
- `allowed_mentions.parse=[]` always
- At-least-once; ambiguous timeouts may duplicate
- Consumes `broadcast.daily_budget` / `urgent_ceiling` at channel-render (Telegram uncapped)
- Env: `DISCORD_WEBHOOK_URL`

## Research bot (Gateway)

- **Separate token**: `DISCORD_RESEARCH_BOT_TOKEN` — never the broadcast webhook
- Intents: Guilds, GuildMessages, Message Content (privileged) — required so
  plain channel text works without an @mention
- Channel permissions: View Channels, Read Message History, Send Messages,
  Embed Links, Add Reactions
- No @mention required in allowed channels
- FIFO research queue (one runner); ✅ when claimed; `chat.discord.model`
  defaults to `composer-2.5-fast` for the **initial research reply**; material
  watch updates use `composer-2.5` (host update writer)
- State under `~/.trenchcoat/discord/`; `.lock` (brief store) + `.worker.lock` (research)
- Does not use main `agent/.lock` or research queue
- Config: schema 10 `chat.discord.*` (disabled by default)
- CLI: `tc listen discord`, `tc discord watchlist scan`
- Chat reply target: one message — `<TICKER> research` + TL;DR / X / Web / Read
  (~≤1800 chars); multipart has no `1/n` labels
- Watch baseline = dossier evidence (no post-reply Dex/security/X re-collect);
  subscribe stores `researchBrief` from the reply for update narration
- Skills under `~/.trenchcoat/discord/agent/skills/` do not auto-sync on deploy
- Stuck queue: hung scrape holding `.worker.lock` — see discord-research.md ops
- See [architecture/discord-research.md](../architecture/discord-research.md), ADR 010
