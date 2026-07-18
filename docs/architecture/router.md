---
description: In-repo SQLite router — HMAC intake, durable event queue, Telegram/Discord at-least-once fanout, separate wallet-lifecycle lane.
scope: project
status: active
last_verified: 2026-07-18
read_when:
  - Editing src/router/**, src/lib/router-contract.ts, outbox staging, or broadcast delivery
---

# Router

The orchestrator never talks to Telegram or Discord directly for market broadcasts
or wallet lifecycle notices. It stages schema-valid events into a durable host
outbox, then POSTs them to the in-repo router over loopback HTTP
(`http://127.0.0.1:8787`, bare host defaults to `/v1/events`) or HTTPS off-loopback,
using HMAC headers (`x-tc-timestamp`, `x-tc-nonce`, `x-tc-signature`) — never Bearer
auth.

The router is a **long-lived KeepAlive process** (`com.trenchcoat.router` via
`ops/install-launchd.sh` → `tc router serve`). Jobs only stage + HMAC-POST; without
the router process, broadcasts never fan out. SQLite lives at
`~/.trenchcoat/router.sqlite3`. Destinations come from env at process start:
`TELEGRAM_ROUTER_BOT_TOKEN` + `TELEGRAM_ROUTER_CHAT_ID`, and/or `DISCORD_WEBHOOK_URL`.

## Guarantees

| Property | Guarantee |
|---|---|
| Ingress auth | HMAC-SHA256 over `METHOD\nPATH\nTIMESTAMP\nNONCE\nsha256(body)` with constant-time compare, ±5m skew, nonce replay table |
| Durability | SQLite WAL: events, destination snapshots, deliveries, attempts, nonces, idempotency tombstones |
| Ingress codes | `202` new event, `200` exact duplicate (same eventId + payload hash), `409` eventId/payload conflict (incident log) |
| Fanout | At-least-once to Telegram and Discord. Providers have no idempotency primitive; ambiguous timeouts record duplicate risk |
| Lanes | `finding.broadcast` consumes the daily market budget; `wallet.lifecycle` is a separate durable lane and never spends that budget |
| Text ownership | Lifecycle one-liners are host-rendered from trusted reason codes/metrics. LLM prose is never forwarded |

## Event shapes

Frozen in `src/contracts/schemas.ts` as `RouterEventSchema`.

- `finding.broadcast` — severity `watch|notable|urgent`, length-capped `text`, state refs, host-verifiable `auditClaim`, optional `channels` payloads
- `wallet.lifecycle` — severity `lifecycle`, host-rendered `reasonLine`, immutable transition metadata (no `channels`; never distilled)

Event ids are content hashes of the canonical broadcast fields (not `channels`).
Replays of the exact same full payload are duplicates; same id with a different
payload is a conflict.

### Per-channel payloads

Host `renderChannelPayloads` (orchestrator, before first POST) may attach:

| Destination | Source |
|---|---|
| Telegram | Promoted `reports/chat/<run-id>.md` when present; else `event.text` |
| Discord | Fail-closed distiller from the chat report (new-things-only, no provenance handles, ≤3 tickers, no status-quo filler); on any miss falls back to `event.text` |

The router never runs models. Fanout picks `event.channels.<kind>.text ?? event.text`.

## Delivery workers

- Leased rows with heartbeat; restart recovers incomplete leases
- Bounded concurrency per destination
- Honour `Retry-After`, jittered backoff, dead-letter after N attempts
- Telegram: plain text, no parse mode. Host never truncates — `splitTelegramText`
  in `src/lib/telegram-bot.ts` chunks at ~3800 chars on paragraph boundaries
  (numbered `1/n` …), used by router fanout (`src/router/deliver.ts`) and the
  operator chat listener. Chat replies longer than ~7600 chars also persist under
  `agent/reports/chat/` with a short summary pointing at the file.
- Discord: webhook `wait=true`, `allowed_mentions.parse=[]`. Soft chunk ~1900
  chars (`splitDiscordText` in `src/router/deliver.ts`) with numbered `1/n`
  parts and stable per-part `Idempotency-Key` (`<deliveryId>:part:i/n`) so
  retries do not invent new keys. Distiller still targets ≤1000 when it succeeds.
- Graceful shutdown drains in-flight leases, then exits

## Security surface

- Bind loopback by default; plain HTTP allowed only on loopback; TLS required off loopback
- Body/connection limits on Fastify
- No credentials under `agent/`
- Orchestrator holds HMAC key and router URL in host env only (INV-B1)

## Ops

- Install/load: `./ops/install-launchd.sh` (writes + bootstraps `com.trenchcoat.router`;
  runtime prod install rebuilds `better-sqlite3` native bindings)
- Health: `curl -sS http://127.0.0.1:8787/healthz` → `{"ok":true}`
- Logs: `/tmp/trenchcoat.router.{out,err}.log`
- Kick: `launchctl kickstart -k gui/$(id -u)/com.trenchcoat.router`

See ADR 001 for the delivery-guarantee decision.
