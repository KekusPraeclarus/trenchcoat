---
description: Provider knowledge — Telegram preview and GramJS listener.
scope: project
status: active
last_verified: 2026-07-20
---

# Telegram

- Preview mode via `t.me/s` fixtures/parsers — preferred for public alpha channels
- GramJS for preview-disabled channels only (scaffold; CLI does not inject the
  listener yet; needs `~/.trenchcoat/telegram-session/session.txt`)
- FLOOD_WAIT backoff; atomic finalized message writes; heartbeat + cursor
- Operator chat bot is separate from router fanout bot
- Chat replies allowlist-checked before any handling (INV-B3)
- Market fanout Telegram text is a fail-closed landscape overview (`telegram_overview`),
  not the host chat-recall dump; Discord stays a run-scoped **own** bottom-line
  distill (at most one Discord payload per run — never a reuse of the TG closer)

## Alpha ingestion vs operator chat

| Surface | Process | Config / env |
|---------|---------|--------------|
| Alpha channels | `tc listen channels` / `com.trenchcoat.channels` | `telegram_channels[]` |
| Operator DMs | `tc listen telegram` / `com.trenchcoat.listener` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OPERATOR_ID` |
| Broadcast fanout | `tc router serve` / `com.trenchcoat.router` | `TELEGRAM_ROUTER_*` |

Working alpha: `mode: "preview"`, poller logs `preview:N` / `telegram preview polled`
(on a ~30m cycle per channel batch), queue files under `agent/alpha-queue/<channel>/` with `provenance: telegram:<channel>`.
List-scan writes `list-scan-alpha-manifest`; review writes `review-alpha-manifest`.
Both are path-only and capped at 500 items (`truncated=N` when the queue is
deeper) so digest can still run while backlog is drained. Overflow keeps the
first 499 paths in channel/file sort order and drops the rest until later runs
digest + purge (INV-Q1) shrink the queue — never mass-delete undigested files
to “fix” the cap. Mid-day 2026-07-19 list-scans aborted with Zod `too_big`
before the cap shipped; current runtimes must always call `capManifestLines`
before `SnapshotWriter.writeInbox`. List-scan collection status / chat notes
surface `alphaPending` and `alphaTruncated` when the queue is non-empty or
capped. Digests must use `entries[]` with message/record `contentHash` values
(byte hashes of on-disk files) — narrative-shaped `items`/`slug` digests fail
Zod and purge **nothing** (`invalidReason=schema-invalid` on the receipt; chat
notes `alphaDigestInvalid` / `alphaPurged`). 2026-07-19 live backlog (~500) was
zero successful purges for that reason. Repo skill edits under `agent/skills/**`
do **not** auto-deploy — copy into `~/.trenchcoat/agent/skills/` before live
jobs (installer does not sync skills).
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
- **Queue deep / digests never purge** — agent wrote narrative `items` instead of
  `entries` + content hashes. Receipt shows `invalidReason=schema-invalid` and
  chat `alphaDigestInvalid` / `alphaPurged=0`. Fix skills (list-scan/review), sync
  into `~/.trenchcoat/agent/skills/`, redeploy host; do not mass-delete the queue.
  Last-resort operator drain: `pnpm exec tsx scripts/alpha-queue-drain.ts` (writes
  minimal archive record + host-valid digest; see orchestrator.md § Alpha-queue).
- **Skill / collector edits** — `ops/install-launchd.sh` redeploys the CLI runtime;
  copy `agent/skills/**` into `~/.trenchcoat/agent/skills/` separately (installer
  does not sync skills).
- **Poll interval change** — default cycle is code in `channels.ts`, not config;
  after redeploy restart **`com.trenchcoat.channels`** and confirm startup log
  `pollMs` (2026-07-19 live: `1800000` = 30m, was `60000`).
