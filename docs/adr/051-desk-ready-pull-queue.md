---
title: "051 — Desk-ready pull-queue as primary Grok intake"
status: accepted
date: 2026-09-06
last_verified: 2026-09-06
---

# ADR 051: Desk-ready pull-queue as primary Grok intake

## Context

ADR 050 posts each Telegram leader to a Cursor Intake webhook. That wake uses
Grok Bot included quota. Quota exhaustion drops the desk even when Telegram
succeeds. Classification on Intake also spends desk tokens.

The desk needs a machine path that a box script can poll with no LLM.

## Decision

1. **Primary path.** Each Telegram leader becomes one `trench.intake.v1`
   ticket. The router appends that ticket to
   `~/.trenchcoat/desk-intake/desk_tickets.jsonl` on HMAC accept. Duplicate
   ticket ids are no-ops.
2. **Pull API.** A second loopback listener (`127.0.0.1:8788`) serves
   `GET /desk/intake/pending` and `POST /desk/intake/ack`. Auth is
   `Authorization: Bearer <DESK_PULL_TOKEN>`. The HMAC router on `:8787`
   stays private. Off-loopback bind requires TLS. Production TLS is a reverse
   proxy that exposes only `/desk/intake/*`.
3. **Watermark.** `since_id` returns tickets after that id. ACK is optional
   bookkeeping. The desk treats `id` as the idempotency key.
4. **Desk-ready class.** The host sets `class` and `next` from the broadcast
   claim. `desk_ready: true` means the desk script must not re-classify.
5. **Webhook is secondary.** `INTAKE_WEBHOOK_URL` plus `INTAKE_SENDER_KEY`
   still POST the same ticket when set. Webhook failure does not fail
   Telegram, Discord, or the pull-queue. Do not retry 400, 401, or 403.
   Quota-class 429 / `resource_exhausted` backs off 15–60 minutes.
6. **Scope.** Pull-queue and webhook still skip digest, lifecycle, correction,
   and topic-merged followers.

## Consequences

- The desk can ingest while Grok Bot quota is dead.
- Operators must set `DESK_PULL_TOKEN` and a public HTTPS front for the box.
- JSONL append failure returns HTTP 500 so ingress retries.
- Ambiguous webhook timeouts can still duplicate a POST. The desk keys on `id`.

## Alternatives considered

- Keep the webhook as the only machine path. Rejected. Quota kills Intake.
- Scrape Telegram for intake. Rejected. Fragile and out of scope.
- Expose HMAC `:8787` publicly. Rejected. INV-B5 intake stays loopback.

## Related

- Extends [ADR 050](050-optional-grok-intake-fanout.md)
- Uses [ADR 001](001-router-delivery-guarantee.md)
- INV-B2 / INV-B4 / INV-B5 in [INVARIANTS.md](../INVARIANTS.md)
