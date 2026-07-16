---
description: In-repo SQLite router — HMAC intake, durable event queue, Telegram/Discord at-least-once fanout, separate wallet-lifecycle lane.
scope: project
status: active
last_verified: 2026-07-16
read_when:
  - Editing src/router/**, src/lib/router-contract.ts, outbox staging, or broadcast delivery
---

# Router

The orchestrator never talks to Telegram or Discord directly for market broadcasts
or wallet lifecycle notices. It stages schema-valid events into a durable host
outbox, then POSTs them to the in-repo router over loopback HTTPS (or plain HTTP
only on `127.0.0.1`/`::1` in tests).

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

- `finding.broadcast` — severity `watch|notable|urgent`, length-capped text, state refs, host-verifiable `auditClaim`
- `wallet.lifecycle` — severity `lifecycle`, host-rendered `reasonLine`, immutable transition metadata

Event ids are content hashes. Replays of the exact same payload are duplicates;
same id with a different payload is a conflict.

## Delivery workers

- Leased rows with heartbeat; restart recovers incomplete leases
- Bounded concurrency per destination
- Honour `Retry-After`, jittered backoff, dead-letter after N attempts
- Telegram: plain text, no parse mode
- Discord: webhook `wait=true`, `allowed_mentions.parse=[]`
- Graceful shutdown drains in-flight leases, then exits

## Security surface

- Bind loopback by default; TLS required off loopback
- Body/connection limits on Fastify
- No credentials under `agent/`
- Orchestrator holds HMAC key and router URL in host env only (INV-B1)

See ADR 001 for the delivery-guarantee decision.
