---
description: Provider knowledge — Discord webhook fanout (router) and Gateway research bot (isolated).
scope: project
status: active
last_verified: 2026-07-20
---

# Discord

## Broadcast webhook (router)

- Router-only webhook delivery with `wait=true`
- `allowed_mentions.parse=[]` always
- At-least-once; ambiguous timeouts may duplicate
- Consumes `broadcast.daily_budget` / `urgent_ceiling` at channel-render (Telegram
  uncapped by count; market proposals still need host worthiness approval —
  ADR 014)
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
  watch updates use `composer-2.5` via a **host-side** update writer (not the
  deep-research agent). Glossed metric diffs + `researchBrief` feed the prompt;
  one retry then soft prose fallback if the session fails
- State under `~/.trenchcoat/discord/`; `.lock` (brief store) + `.worker.lock` (research)
- Does not use main `agent/.lock` or research queue
- Config: schema 10+ `chat.discord.*` (disabled by default); schema 12 adds
  `chain_integration` for exact unknown `slug:address` host automation
- CLI: `tc listen discord`, `tc discord watchlist scan`,
  `tc discord chains run|status|retry|fail|continue`
- Chat reply target: one message — `<TICKER> research` + TL;DR / X / Web / Read
  (~≤1800 chars); multipart has no `1/n` labels
- Watch baseline = dossier evidence (no post-reply Dex/security/X re-collect);
  every non-hard-fail research token is subscribed (silent); `researchBrief`
  stored for update narration; validated `track` may promote to main watchlist
  (host-only, also silent in Discord replies)
- Skills under `~/.trenchcoat/discord/agent/skills/` do not auto-sync on deploy
- Stuck queue: hung scrape holding `.worker.lock` — see discord-research.md ops
- **Chain integration** (host lane, not the Discord agent): exact unknown
  `slug:address` → `~/.trenchcoat/discord/chain-integrations/` → kickstart
  worker → after deploy, **new** runtime CLI `continue` announces then FIFO
  research. Research reservation uses status `awaiting-chain`. Build model
  `cursor-grok-4.5-high`. See
  [discord-chain-integration.md](../architecture/discord-chain-integration.md),
  ADR 016, INV-D2/S26
- See [architecture/discord-research.md](../architecture/discord-research.md), ADR 010, ADR 012
