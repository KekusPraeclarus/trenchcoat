---
description: ADR — Host composer-2.5-fast worthiness gate approves or rejects agent market broadcasts before stage.
scope: project
status: accepted
last_verified: 2026-08-17
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
- The model receives a trusted list of recent accepted broadcasts. Only that
  list may support an "already broadcast" rejection; status-quo narrative state
  and untrusted agent notes are not delivery history.
- Completed resolved deep research with a clear trade, watch, or avoid takeaway
  is worthy even when the conclusion is negative.
- Founder / protocol primary-source catalysts (founder, CEO, protocol official,
  or official project channel announcing a material product, wallet, protocol,
  ecosystem, or distribution catalyst) are worthy on first sighting — never
  reject as "incremental sentiment" or "no stage delta" when absent from
  accepted-broadcast-history.
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
  disabling removes the semantic brake. Discord message budget no longer
  applies (superseded by ADR 041).
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
- Optional: Telegram daily/hourly count ledger if worthiness alone under-filters
  (still deferred). ADR 033 later raised a Discord message budget. ADR 041
  then removed that budget. Daily digest length is a target, not a send gate
  (ADR 049).

## Related

- [ADR 023](023-narrative-development-and-research-broadcast.md) — loads accepted
  router receipts for worthiness repeat checks; same-stage narrative routing and
  mandatory research outbox.
- [ADR 024](024-founder-primary-source-broadcast.md) — founder primary-source
  catalysts are worthy on first sighting.

## Follow-up (ADR 034)

Claim-only worthiness input (no proposal prose / agent.md) and a 48h
`{subject, claimHash}` verdict cache for token and wallet claims — see
[034-token-cost-host-gates.md](034-token-cost-host-gates.md). Open narrative
claim types skip that cache.
