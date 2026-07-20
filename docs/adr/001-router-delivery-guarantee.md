---
description: ADR — Telegram/Discord fanout is durable at-least-once with explicit duplicate risk.
status: accepted
date: 2026-07-16
last_verified: 2026-07-20
---

# ADR 001 — Router delivery guarantee

## Context

Telegram Bot API and Discord webhooks lack a true idempotency primitive. Exact
once delivery cannot be proven after an ambiguous timeout.

## Decision

The router provides durable at-least-once fanout:

- Ingress dedupes on `(eventId, payloadHash)` with conflict detection
- Each destination has its own delivery row and attempt log
- Ambiguous downstream timeouts mark `duplicate_risk=true` and may retry
- Operators accept rare duplicate messages; silent loss is forbidden

## Consequences

- Tests assert one ingress event and ≤N destination attempts, not zero duplicates
- Dead letters are visible and never dropped
- Wallet lifecycle and market findings share durability, not Discord market budget
  (Discord `daily_budget` / `urgent_ceiling` are reserved at channel-render;
  Telegram stays uncapped after schema validation)
