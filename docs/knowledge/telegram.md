---
description: Provider knowledge — Telegram preview and GramJS listener.
scope: project
status: active
last_verified: 2026-07-19
---

# Telegram

- Preview mode via `t.me/s` fixtures/parsers — preferred for public alpha channels
- GramJS for preview-disabled channels only (scaffold; CLI does not inject the
  listener yet; needs `~/.trenchcoat/telegram-session/session.txt`)
- FLOOD_WAIT backoff; atomic finalized message writes; heartbeat + cursor
- Operator chat bot is separate from router fanout bot
- Chat replies allowlist-checked before any handling (INV-B3)
- Market fanout Telegram text is a fail-closed landscape overview (`telegram_overview`),
  not the host chat-recall dump; Discord stays new-things-only distilled

## Alpha ingestion vs operator chat

| Surface | Process | Config / env |
|---------|---------|--------------|
| Alpha channels | `tc listen channels` / `com.trenchcoat.channels` | `telegram_channels[]` |
| Operator DMs | `tc listen telegram` / `com.trenchcoat.listener` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OPERATOR_ID` |
| Broadcast fanout | `tc router serve` / `com.trenchcoat.router` | `TELEGRAM_ROUTER_*` |

Working alpha: `mode: "preview"`, poller logs `preview:N` / `telegram preview polled`,
queue files under `agent/alpha-queue/<channel>/` with `provenance: telegram:<channel>`.
List-scan writes `list-scan-alpha-manifest`; review writes `review-alpha-manifest`.
Both are path-only and capped at 500 items (`truncated=N` when the queue is
deeper) so digest can still run while backlog is drained.
Operator chat working (`operator:telegram:…` research) does **not** imply alpha
ingestion is live — check channels poller logs and `alpha-queue/` separately.

## Troubleshooting

- **Idle poller / no queue growth** — allowlist is all `gramjs` and session missing.
  Logs: `preview:0` + `skipping gramjs until auth`. Fix: set channels to
  `mode: "preview"`, restart **channels** (not listener).
- **Only `@telegram` product blog in queue** — config (or stale cursor) used the
  handle `telegram`. Remove that entry; purge `alpha-queue/telegram/` and the
  `telegram` cursor key; use real alpha handles.
- **Seed defaults** — `config/seed.example.json` is preview-first for all listed
  public call channels.
- **Skill / collector edits** — `ops/install-launchd.sh` redeploys the CLI runtime;
  copy `agent/skills/**` into `~/.trenchcoat/agent/skills/` separately (installer
  does not sync skills).
