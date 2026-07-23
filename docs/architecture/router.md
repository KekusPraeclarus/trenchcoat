---
description: In-repo SQLite router — HMAC intake, durable event queue, Telegram/Discord at-least-once fanout, separate wallet-lifecycle lane.
scope: project
status: active
last_verified: 2026-07-21
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

Broadcast proposal `refs` may cite `state/…` or same-run `inbox/<run-id>/…` only.
At ingest the host requires each path to be a regular non-symlink file already
frozen in the sealed run archive (inbox via pre-archive manifest; state under
`agent/state`), rejects traversal/cross-run/missing/mutable refs, and
canonicalizes same-run inbox refs to `archive/runs/<run-id>/inbox/…` **before**
deriving the router `eventId`.

Failed or skipped ingress is retried by the host-only `delivery-retry` job
(`tc delivery retry` / `tc run delivery-retry`, launchd every 15m): oldest-first
bounded batch, channel-render before ingress, persist after every attempt, router
`(eventId, payloadHash)` dedupe, conflicts terminal/operator-visible, transient failures remain queued
with backoff. Counts live in `summarizeIngressCounts` /
`snapshotBroadcastPipeline` for status/health wiring.

`finding.broadcast` ingress fails closed when its Telegram channel payload is
absent. This prevents a legacy or interrupted raw event from falling back to the
same short text on both channels: Telegram receives the promoted landscape
overview, while Discord receives a run-scoped bottom-line distillation.

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
| Lanes | Discord `finding.broadcast` consumes `broadcast.daily_budget` / `urgent_ceiling` at channel-render; Telegram is uncapped after validation; `wallet.lifecycle` and `finding.correction` never spend Discord market budget |
| Text ownership | Lifecycle one-liners are host-rendered from trusted reason codes/metrics. LLM prose is never forwarded. Correction copy is host-rendered from sealed revalidation artifacts (INV-S28) |

## Event shapes

Frozen in `src/contracts/schemas.ts` as `RouterEventSchema`.

- `finding.broadcast` — severity `watch|notable|urgent`, length-capped `text`, state refs, host-verifiable `auditClaim`, optional `channels` payloads
- `finding.correction` — severity `info`, host integrity notice after post-fix claim audit (INV-S28); carries `correction` metadata (incidentId, invalidatedClaimIds, originalEventIds, optional Discord reply target); requires pre-attached channel payloads; bypasses worthiness and Discord market budget; Discord may reply to a persisted provider message ID for a single-claim correction, else standalone
- `wallet.lifecycle` — severity `lifecycle`, host-rendered `reasonLine`, immutable transition metadata (no `channels`; never distilled)

Event ids are content hashes of the canonical broadcast fields (not `channels`).
Replays of the exact same full payload are duplicates; same id with a different
payload is a conflict. Correction event ids are stable hashes of
incident + destination + sorted invalidated claim ids.

### Per-channel payloads

`finding.broadcast` ingress requires host-rendered `channels` — Telegram may be
omitted for same-run topic-merged followers (router skips that destination).
`narrative.digest` requires `channels.telegram` with text byte-identical to
`event.text`. `finding.correction` requires at least one of
`channels.telegram` / `channels.discord`, and only those destinations that
originally received an invalidated public broadcast (INV-S28 — never for
internal-only narrative/decision invalidations). Host `renderChannelPayloads`
(orchestrator, before first POST) applies only to `finding.broadcast` and attaches:

| Destination | Source |
|---|---|
| Telegram (intraday) | One fail-closed **topic deep-dive** per normalized `auditClaim.subject` per run when `broadcast.telegram_overview.enabled` (bounded topic packet only — never the global chat report; ≤3,400 Markdown chars; no other-narrative inventory; no host plumbing / workspace paths / provenance or bare @handles); on miss uses packet fallback. Same-subject followers omit `channels.telegram` (`topic-merged`). No daily message-count limit |
| Telegram (daily) | Host-only `narrative.digest` at 20:00 Europe/London (`broadcast.telegram_digest.enabled`): every retention-active narrative in one message (≤3,400 chars), immutable `archive/telegram-digests/<date>.json`, day-keyed `eventId` |
| Discord | Fail-closed **own** bottom-line distill from the chat report (≤320 chars, ≤3 tickers, no provenance or bare @handles, no trader roll calls, no status-quo filler / unchanged-stage restatement) — never reuse Telegram topic text; at most one Discord payload per run — later claims omit `channels.discord` (`run-deduped`, no budget burn); prior narrative heat passed as `unchangedStages`; on any miss falls back to `event.text`. Consumes `broadcast.daily_budget` / `urgent_ceiling`; over budget omits `channels.discord` |

The router never runs models. Fanout picks `event.channels.<kind>.text ?? event.text`.
When `channels` is present and a destination payload is absent, that destination is
skipped (`skipped-discord-budget` / `skipped-no-channel-payload`). Discord is
intentionally single-shot per run; intraday Telegram is one message per subject.

## Delivery workers

- Leased rows with heartbeat; restart recovers incomplete leases
- Bounded concurrency per destination
- Honour `Retry-After`, jittered backoff, dead-letter after N attempts
- Telegram: markdown → HTML (`parse_mode: HTML`) with plain fallback on reject.
  Before conversion, host deslugs kebab narrative labels
  (`rh-chain-meme-rotation` → `RH Chain Meme Rotation`) and scrubs leaked hour
  tokens only (`72h` → `the next few days`; natural phrases like `this week` /
  `this month` are left alone) via `narrative-label.ts` / `watch-window.ts`.
  Channel distill injects a host-derived `watchWindow` (decoupled from audit
  `horizonHours`) so copy can use day/week/month phrasing without echoing `Nh`
  ([ADR 013](../adr/013-watch-window-decoupled.md)).
  Host never truncates — `telegramSendFormattedChunks` in `src/lib/telegram-bot.ts`
  chunks at ~3400 chars of markdown on paragraph boundaries (numbered `1/n` …),
  used by router fanout (`src/router/deliver.ts`) and the operator chat listener.
  Chat replies longer than ~7600 chars also persist under `agent/reports/chat/`
  with a short summary pointing at the file.
- Discord: webhook `wait=true`, `allowed_mentions.parse=[]`. Soft chunk ~1900
  chars (`splitDiscordText` in `src/router/deliver.ts`) with numbered `1/n`
  parts and stable per-part `Idempotency-Key` (`<deliveryId>:part:i/n`) so
  retries do not invent new keys. Distiller still targets ≤320 when it succeeds.
  Successful deliveries persist provider message IDs on the delivery row
  (`provider_message_ids`) so single-claim `finding.correction` can reply on
  Discord when an ID exists; missing IDs fall back to standalone.
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
