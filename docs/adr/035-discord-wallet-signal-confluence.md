---
description: Read-only Discord wallet-signal confluence from Cielo/relay channels, isolated from wallets.json; FOMO-style buy confluence and sell-pressure context.
scope: project
status: accepted
date: 2026-07-23
supersedes: []
---

# ADR 035 — Discord wallet-signal confluence

## Context

Server Discord channels receive Cielo/relay wallet-alert embeds (Solana + EVM).
Operators want FOMO-style confluence (many distinct actors buying the same CA →
bullish confirm; many selling → bearish evidence; silence ≠ bearish) without
coupling to host smart-wallet state (`wallets.json` / wallet-scan).

## Decision

1. **Transport:** host job `discord-wallet-signal-scan` polls Discord REST history
   every 5m via `DISCORD_RESEARCH_BOT_TOKEN` (Read Message History only; never
   Send). Gateway research listener early-ignores `wallet_signals.channel_ids`.
2. **Config:** `chat.discord.wallet_signals` (schema **20**). Seed enables with
   placeholder Solana and EVM channel ids, `shadow_mode: true`. Channels must be
   disjoint from `chat.discord.channel_ids`. Put live ids only in
   `~/.trenchcoat/config.json`.
3. **Parse:** allowlisted grammars from
   [discord-wallet-alert-schemas.md](../knowledge/discord-wallet-alert-schemas.md).
   Confluence requires `tokenContract` + `side` buy/sell + `confidence` high|medium.
   `human_lossy` is low confidence and never confluence.
4. **Derive:** ≥ `min_actors` (default 3) distinct actors in `window_minutes`
   (60) → buy `convergence` (bullish) or sell `sell-pressure` (bearish). Actor
   + CA + side dedupe TTL 15m. Empty window emits no bearish signal.
5. **Enqueue:** buy confluence only when `shadow_mode === false`;
   `enqueuedBy: "discord-wallet:convergence"`, priority 50, daily cap 3. Sell
   never enqueues.
6. **Isolation:** collectors under `src/collectors/discord-wallet/` never write
   `wallets.json` / wallet lifecycle. Observations live under archive
   `provider-observations/discord-wallet/` and cursors under
   `~/.trenchcoat/discord/wallet-signal-cursors.json`.
7. **Research context:** dossiers may include `discord-wallet-context` from the
   observation cache (parallel to `fomo-context`).

## Consequences

- Confirmatory confluence without expanding smart-wallet surface.
- Shadow mode lets operators verify parse before research enqueue.
- Hard channel disjoint prevents wallet feeds from hitting research/conversation.

## References

- [discord-wallet-signals.md](../architecture/discord-wallet-signals.md)
- INV-S19 (Discord wallet-signal actors ≠ smart wallets)
- ADR 034 (session separation preserved)
