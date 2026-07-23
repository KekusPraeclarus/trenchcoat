---
description: Discord wallet-signal confluence lane — REST poll, parse, derive, research bridge, isolation from smart wallets.
scope: module
status: active
last_verified: 2026-07-23
read_when:
  - Editing discord-wallet collectors, discord-wallet-signal-scan, or wallet_signals config.
  - Debugging Cielo/relay Discord channel confluence.
---

# Discord wallet-signal confluence

Read-only host lane that polls configured Discord channels for Cielo/relay
wallet-alert embeds, derives FOMO-style buy/sell confluence, and optionally
enqueues research on buy convergence. Fully isolated from
`state/wallets.json` (ADR 035 / INV-S19).

## Job

| Item | Value |
|---|---|
| Name | `discord-wallet-signal-scan` |
| Cadence | every 5m (`ops/install-*.sh`) |
| Auth | `DISCORD_RESEARCH_BOT_TOKEN` |
| Agent | never (`skipAgent`, host-only) |

## Config

`chat.discord.wallet_signals` (schema 20). When `enabled`, requires Discord
enabled + `guild_id` + 1–20 unique `channel_ids` **disjoint** from research
`channel_ids`. Defaults: `shadow_mode` true, `min_actors` 3, windows 60m,
`max_enqueues_per_day` 3.

## Paths

| Path | Role |
|---|---|
| `~/.trenchcoat/discord/wallet-signal-cursors.json` | per-channel `lastMessageId` |
| `archive/provider-observations/discord-wallet/latest.json` | TxEvent cache (24h) |
| `archive/provider-cursors/discord-wallet/activity.json` | last poll time |
| `archive/provider-usage/discord-wallet/enqueues-YYYY-MM-DD.json` | daily enqueue count |

## Flow

1. REST `fetchChannelWindow` per channel (`src/discord/history.ts`)
2. Parse allowlist (`src/collectors/discord-wallet/parse.ts`)
3. Merge observations; derive buy convergence / sell pressure
4. Write inbox `discord-wallet-signals`
5. If `!shadow_mode`, enqueue buy convergence only

Gateway listener ignores wallet channel IDs. Research dossiers may attach
`discord-wallet-context` from the observation cache.

## Parse contract

See [discord-wallet-alert-schemas.md](../knowledge/discord-wallet-alert-schemas.md).
