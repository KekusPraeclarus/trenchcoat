---
description: Discord research bot — private-guild Gateway listener, isolated state, final-only replies, watch subscriptions.
scope: module
status: active
last_verified: 2026-07-19
read_when:
  - Editing src/discord/ or chat.discord config.
  - Changing Discord research intake, delivery, watchlist, or monitor behaviour.
---

# Discord research bot

Private-guild research-only bot isolated from the main agent and from router
webhook broadcasts (ADR 010).

## Two Discord surfaces (do not conflate)

| Surface | Token / transport | Purpose |
|---|---|---|
| Router broadcast | `DISCORD_WEBHOOK_URL` | Market `finding.broadcast` fanout (budgeted at channel-render) |
| Research bot | `DISCORD_RESEARCH_BOT_TOKEN` + discord.js Gateway | Interactive research + watch updates in configured guild channels |

## Product contract

- One configured guild (`chat.discord.guild_id`) and 1–20 explicit text channels
- Any non-bot member with channel access may request research (no user allowlist)
- **No @mention required** — Message Content Intent + channel allowlist; plain
  `Research solana:<CA>` (or bare CA / `chain:CA`) in an allowed channel is enough
- Research-only: no `/status`, exoneration, main watchlist commands, or broadcasts
- **FIFO queue** — concurrent requests enqueue (`queued`); one runs at a time
  under `.worker.lock`. Per-user depth capped by `max_active_per_user` (default 5);
  excess gets a terminal queue-full error. Daily caps still apply on accept
- **Start signal** — ✅ (`white_check_mark`) reaction when claimed
  (`queued` → `running`); queued messages stay silent until then
- **Model** — `chat.discord.model` (default `composer-2.5-fast`) for the initial
  research reply only; six-hour watch updates use `composer-2.5` via a host-side
  update writer. Does not change Telegram / main orchestrator sessions.
- **Final-only text replies** — no typing/progress messages; next bot message is
  the result or one terminal error (quota / queue-full / bot-busy). Renewal ack
  is the sole non-result text reply
- Unrelated chatter, ticker-only, bots/webhooks, DMs, wrong guild/channel, and
  edits are ignored silently

## Commands and scheduling

- `tc listen` — primary KeepAlive entry (`com.trenchcoat.listener`): Telegram
  operator bridge plus a supervised Discord child when config + token are set
- `tc listen discord` — Discord only (debug)
- `tc discord watchlist scan` — material monitor; launchd calendar 0/6/12/18 local
  (`com.trenchcoat.job.discord-watchlist-scan`)
- `tc status` — Discord section when `chat.discord.enabled` (heartbeat, queue,
  watched tokens/subscribers; never posted into Discord)

## State layout (`~/.trenchcoat/discord/`)

| Path | Role |
|---|---|
| `requests.json` | Intake, UTC quotas, delivery state (id = message snowflake) |
| `watchlist.json` | Canonical tokens + per-user subscriptions |
| `observations.json` | Monitor baselines |
| `deliveries.json` | Pending update deliveries |
| `agent/` | Isolated inbox/reports/skills (copied on first run) |
| `archive/` | Discord-only run archive |
| `.lock` | Brief store JSON exclusivity (separate from `agent/.lock`) |
| `.worker.lock` | Long research / monitor exclusivity (so intake can still accept) |

Malformed state files are quarantined and the process stops (fail closed).

## Research path

1. `extractDiscordResearchIntent` (`src/discord/intent.ts`) — stricter than
   Telegram: CA required; shares extraction helpers via
   `src/chat/research-intent-core.ts`
2. `acceptDiscordRequest` — quota + per-user queue depth; durable `queued` accept.
   Daily caps charge queued/running/completed only (failures do not consume).
3. `processNextDiscordRequest` — oldest queued → running under worker lock; ✅
4. `runDiscordResearch` — resolve + collect + `runResearchPasses` (Discord model)
   under `discord/agent/`; **no** main queue, proposals, INDEX, or outbox.
   Chat summary aims for one Discord message: `<TICKER> research` then TL;DR /
   X / Web / Read (Market/Security should be included in either tl;dr or read, only when material). Summarative X
   and prose Web (no post lists, engagement tables, sample disclaimers, or
   link dumps); detail stays in `agent.md`. Multipart replies stay unlabeled.
   Dossier collection reuses resolve
   DexScreener pairs and runs market/security, FOMO context, and X concurrently;
   optional Tavily queries run concurrently before pass 2. Stage timings
   (resolve/dossier/passes/promotion/reply/subscription) are logged without
   user content.
5. `deliverResearchReply` — sanitized chat body, chunked without `1/n` labels;
   request completion is persisted under `.lock` so concurrent accepts cannot
   overwrite delivery. Watch baseline is built from the research dossier
   (same market/security/X evidence) — no second DexScreener/security/X collect.

Security hard-fail still delivers the report but skips watch subscription.
Otherwise subscription requires a host-validated `track` verdict from
`decision-proposals.json` (`evaluateResearchSubscribe`): missing/malformed
verdicts, `ignore`/`revisit`, mintable memecoins, and mint-without-classification
all skip subscribe while still delivering the report.

## Watchlist and monitor

- 30-day subscriptions per `(guildId, userId, chain, tokenAddress)`; renew via
  reply `renew` / `renew watch` / `keep watching` on own anchor (7-day grace)
- On subscribe, host stores a bounded `researchBrief` (≤1200 chars, TL;DR-first)
  from the delivered research reply for later update context
- Monitor collects market/security/X without a model; strict material thresholds
  in `src/discord/materiality.ts` (price ≥50%, liquidity/volume/fdv 2×/0.5×,
  X authors net +50/−100, engagement 2×/0.5×, security always)
- Material diffs trigger `composer-2.5` watch-update writer (`PERSONA_VOICE`,
  fail-closed to facts-only bullets if the session rejects)
- Resumable scan cursor in `monitor-cursor.json`

## Source files

- `src/discord/listener.ts` — Gateway intake + pump
- `src/discord/pump.ts` — accept + FIFO processor
- `src/discord/research-run.ts` — isolated research (`evaluateResearchSubscribe`)
- `src/discord/research-brief.ts` — bounded TL;DR extract for watch context
- `src/discord/watch-update-session.ts` — host watch-update writer session
- `src/discord/watchlist.ts` — subscriptions + renewals
- `src/discord/monitor.ts` — scheduled scan
- `src/discord/store.ts` — atomic JSON stores
- `src/discord/render.ts` — path strip + Discord markdown safety
- `src/discord/bot-client.ts` — REST replies (8-attempt retry on 429/5xx)

## Ops pitfalls

- **Stuck FIFO** — `.worker.lock` is held for the whole research unit (dossier +
  agent passes + reply + subscription). A hung Playwright X scrape blocks the
  pump even when replies already landed. Symptom: `queued` rows with a live
  discord child and stale/no stage logs. Fix: kill the discord child (or
  kickstart `com.trenchcoat.listener`), clear a dead-owner `.worker.lock`, let
  `reclaimOrphanedDiscordRequests` move orphaned `running` → `queued`. Operator
  purge: mark the request `failed` in `requests.json` then restart the worker.
- **No second X scrape** — watch baseline is built from the research dossier.
  Pre-acceleration builds re-scraped X after reply and were the usual hang.
- **Skills** — `~/.trenchcoat/discord/agent/skills/` are copied on first workspace
  create only. `install-launchd.sh` does **not** sync them (same class as main
  `agent/skills/`). After editing `deep-research` / `research` skills, copy into
  both `~/.trenchcoat/discord/agent/skills/` and `~/.trenchcoat/agent/skills/`.
- **Cold start** — supervised `tc listen` can take ~10–20s of ESM load before
  `discord listener child started` (process may show `STAT U`). Do not treat that
  window as a hung queue. `launchctl bootstrap` often returns `Bootstrap failed:
  5`; recover with bootout → sleep → bootstrap → `kickstart -k`.

## Enablement

1. `tc config migrate --write` (schema 10)
2. Set `chat.discord.enabled`, `guild_id`, `channel_ids` in config
3. `DISCORD_RESEARCH_BOT_TOKEN` in `~/.trenchcoat/env` (mode 600; scrubbed from
   Cursor child env)
4. Developer Portal: Message Content intent; invite with View/Send/History/Embed only
5. `./ops/install-launchd.sh` and kick `com.trenchcoat.listener`

See [CONFIG.md](../CONFIG.md), [knowledge/discord.md](../knowledge/discord.md),
INV-D1.
