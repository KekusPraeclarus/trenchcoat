---
description: Provider knowledge — Discord webhook fanout (router) and Gateway research bot (isolated).
scope: project
status: active
last_verified: 2026-07-21
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
  plain channel text works without an @mention **for research**
- Channel permissions: View Channels, Read Message History, Send Messages,
  Embed Links, Add Reactions
- Research: no @mention required in allowed channels
- Idea-tracking (ADR 018 / ADR 019): **requires** @mention or reply-to-bot;
  ack 🫡; state in `tracking.json`; default `chat.discord.tracking.enabled: true`.
  Every @mention/reply still runs the intent classifier; non-tracking chatter
  should return `{"action":"none"}` (no state mutation, classifier cost only).
  Alerts stay silent until ticker/CA + solid research qualify, then a non-reply
  `@user I found a token matching <shortLabel>` plus full research (ADR 019).
  Flipping the schema default does not override an explicit live
  `~/.trenchcoat/config.json` value — set that too when enabling/disabling.
- FIFO research queue (one runner); ✅ when claimed (user research only);
  `chat.discord.model` defaults to `composer-2.5-fast` for the **initial
  research reply**; material watch updates use `composer-2.5` via a **host-side**
  update writer (not the deep-research agent). Tracking intent/match default to
  `composer-2.5`; mention review defaults to `composer-2.5-fast`
- State under `~/.trenchcoat/discord/`; `.lock` (brief store) + `.worker.lock` (research)
- Does not use main `agent/.lock` or research queue
- Config: schema 10+ `chat.discord.*` (disabled by default); schema 12 adds
  `chain_integration` for exact unknown `slug:address` host automation;
  `chat.discord.tracking` for NL idea-tracking
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
- See [architecture/discord-research.md](../architecture/discord-research.md),
  [architecture/discord-tracking.md](../architecture/discord-tracking.md),
  ADR 010, ADR 012, ADR 018, ADR 019
