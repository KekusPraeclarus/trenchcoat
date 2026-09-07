---
title: "050 — Optional Grok intake fanout"
status: accepted
date: 2026-09-04
last_verified: 2026-09-07
---

# ADR 050: Optional Grok intake fanout

## Context

A Grok Bot desk needs a machine-readable twin of each public Telegram
narrative. Telegram must stay the human feed. A webhook failure must not
block Telegram or Discord. Digest, wallet lifecycle, and correction events
are not desk intake.

## Decision

1. **Same leader text.** Intraday `finding.broadcast` leaders keep the ADR 041
   Telegram render. `channels.grok` is a `trench.intake.v1` JSON twin of that
   text. Topic-merged followers omit Grok.
2. **Optional destination.** The router registers Grok only when both
   `INTAKE_WEBHOOK_URL` and `INTAKE_SENDER_KEY` are set in the live process
   env (`~/.trenchcoat/env`). A checkout `.env` does not enable fanout.
   The URL must be HTTPS. Either missing value, or a bad URL, skips Grok.
3. **Isolated delivery.** Grok has its own SQLite delivery row. A Grok
   failure retries only Grok. Telegram and Discord results stay unchanged.
4. **Scope.** Grok receives `finding.broadcast` leaders only. It does not
   receive `narrative.digest`, `wallet.lifecycle`, `wallet.convergence`, or
   `finding.correction`.
5. **Send contract.** POST JSON with `Authorization: Bearer`. Redirects are
   blocked. Success is 2xx. Retry 408, 429, 5xx, and network errors three
   times. Do not retry 400, 401, or 403. Do not log the sender key.
   Quota-class errors back off 15–60 minutes (ADR 051).
6. **Health ping.** A desk ping is `POST {"ping":true}` to the webhook. It
   must not go through the router, or Telegram and Discord would also send.
7. **Primary machine path is ADR 051.** The pull-queue is required. This
   webhook is best-effort.

## Consequences

- Operators can enable the desk without a second Telegram bot.
- Live webhook fanout stays off until both `INTAKE_*` keys land in
  `~/.trenchcoat/env` and the router restarts. The pull-queue still
  appends without those keys (ADR 051).
- Ambiguous timeouts can duplicate a Grok ticket. The desk must treat `id`
  as the idempotency key.
- The send path enforces a 30s total abort. It does not enforce a separate
  10s connect timeout.

## Alternatives considered

- Replace Telegram with the webhook. Rejected. Telegram stays the human feed.
- Send Grok from the orchestrator before router ingress. Rejected. Ingress
  success would couple to the desk, and retries would not be per destination.
- Fan out digest, lifecycle, and corrections. Rejected. Those events are not
  desk narratives.

## Related

- Extends [ADR 041](041-unified-broadcast-fanout.md)
- Uses [ADR 001](001-router-delivery-guarantee.md) per-destination rows
- Extended by [ADR 051](051-desk-ready-pull-queue.md)
- INV-B2 / INV-B4 / INV-B5 in [INVARIANTS.md](../INVARIANTS.md)
