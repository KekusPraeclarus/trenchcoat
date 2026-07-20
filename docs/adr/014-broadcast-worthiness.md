---
description: ADR — Host composer-2.5-fast worthiness gate approves or rejects agent market broadcasts before stage.
scope: project
status: accepted
last_verified: 2026-07-20
---

# ADR 014 — Broadcast worthiness review

## Context

Streaming social scans (`telegram-alpha` per new channel message; KeepAlive
`x-scan` list-scan rounds) raise how often the sandboxed agent can propose
operator broadcasts. Soft skill guidance (“skip when nothing actionable”) and
mechanical gates (schema, frozen refs, narrative stage dedupe, Discord daily
budget) were not enough: Telegram fanout stays **uncapped by count** after
validation (INV-B2), so a chatty model could still stage many validated sends.

We needed an explicit semantic gate that is cheap enough to run on every
surviving proposal, without letting the host invent market broadcast copy.

## Decision

- After mechanical validation in `ingestOutbox` and **before** `Outbox.stage`,
  run a host ask-mode Cursor session (`src/orchestrator/broadcast-worthiness.ts`)
  that returns only `{"worth":boolean,"reason":string}`.
- Default model: `composer-2.5-fast` via `broadcast.worthiness.model` (enabled
  by default). Configurable; fail-closed when enabled.
- Agent still authors `text` / `auditClaim` (INV-B2: host never invents market
  broadcast text). The fast model only approves or rejects.
- Session error, malformed JSON, missing runner, or `worth:false` → reject with
  a `worthiness:…` receipt in `broadcast-rejects.json`; never stage.
- Applies to **all** jobs that ingest `finding.broadcast`, not streaming-only.
- Wallet `lifecycle` events are unchanged (host-staged, separate lane / budget).

## Consequences

- High-cadence agent runs no longer imply high-cadence Telegram fanout —
  each proposed item must clear a second model review.
- Worthiness is a latency and CLI-session cost on every mechanically-valid
  proposal; empty outbox / no proposals incur no session.
- Operators can disable or retarget the model via config without code changes;
  disabling removes the semantic brake (Discord budget still applies).
- Distillers remain rewrite-only and still omit `model` (default `composer-2.5`);
  do not conflate worthiness with Discord/Telegram distill.

## Alternatives considered

- **Telegram daily count ledger mirroring Discord** — deferred; volume concern
  was “spammy thin updates,” not raw quota. Worthiness addresses quality first;
  a count cap can still be added later if needed.
- **Host invents broadcast text from trusted facts** — rejected; would reverse
  INV-B2 authorship and enlarge the attack/prompt surface on egress copy.
- **Streaming-jobs-only gate** — rejected; same proposal path for
  narrative-scan / farcaster-scan / review; one consistent ingest pipeline.
- **Fail-open on session error** — rejected; would reintroduce spam under CLI
  outages just when operators least want noise.

## Follow-ups

- Optional: archive worthiness approve reasons alongside reject receipts for
  operator tuning.
- Optional: Telegram daily/hourly count ledger if worthiness alone under-filters.
