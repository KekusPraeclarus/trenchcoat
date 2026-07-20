---
description: ADR — Allowlisted telegram-alpha channels enqueue research on a single CA or ticker; research may broadcast when solid.
scope: project
status: accepted
last_verified: 2026-07-20
---

# ADR 015 — Telegram alpha auto-research bridge

## Context

Streaming `telegram-alpha` retained durable notes (e.g. `$SWOGE`) but never
enqueued the research queue. Social research nominations from `list-scan` /
`farcaster-scan` require ≥2 independent authors citing a verbatim CA, and the
telegram-alpha sealed inbox previously stored path-only manifests — so even a
nomination would fail evidence checks. Research also did not propose market
outbox items, so Discord webhook fanout never fired after a solid dossier.

Operator intent: when an allowlisted alpha channel surfaces a token, research
should start immediately; if the dossier is solid, a market broadcast may go
to the Discord webhook (still gated by worthiness + Discord budget).

## Decision

- **Seal message bodies** into `inbox/<run-id>/telegram-alpha-<channel>-<id>.json`
  during `collectTelegramAlpha` (keep the path-only manifest for navigation).
- **Host bridge** (`telegram-alpha-research.ts`) after the agent session:
  - Verbatim Solana/EVM CA → `resolveResearchSubject` → enqueue
    `trigger: "social"`, `clusterCount: 1`, `resolution: "resolved"`.
  - No CA → extract cashtags + deterministic chain hints from shill text →
    DexScreener resolve. Deterministic win → enqueue; ambiguous shortlist →
    host `composer-2.5-fast` disambiguation (`DISAMBIGUATION_PROMPT`) with
    security scans + mechanical filters (chain-hint contradiction, hard-fail);
    confidence ≥60 → `model-confirmed`; else park `ambiguous`.
  - Cap 3 enqueues/run; skip watchlist/queue dupes; receipt archived.
- **`scheduleResearchDrain`** when any enqueue is accepted.
- **Research** may write `outbox/<run-id>.json` when solid; telegram-alpha
  prefers empty outbox (research owns notify). Host never invents market text
  (INV-B2 / ADR 014 worthiness still applies).
- List-scan / farcaster-scan **keep** the ≥2-author bar — this bridge is
  separate and limited to operator-allowlisted TG alpha channels.

## Consequences

- Alpha CA/ticker surfacing no longer depends on agent skill compliance for
  enqueue.
- Ticker-only messages can still resolve via chain hints + market/security
  ranking; unresolved shortlists park without launching research.
- Chart-image matching is out of scope until the TG collector captures images
  (preview scrape is text-only today).
- More research drain load under busy alpha channels; daily research cap and
  enqueue cap bound blast radius.

## Alternatives considered

- **Agent-only research-candidates from telegram-alpha** — rejected; SWOGE showed
  soft guidance is skipped, and path-only inbox cannot prove CAs.
- **Relax ≥2 authors globally** — rejected; would spam research from FYP noise.
- **Host invents broadcast text after research** — rejected; INV-B2 authorship.

## Follow-ups

- Optional: capture TG preview image URLs for chart-vs-CA matching.
- Optional: surface telegram-alpha-research receipts in chat-report facts.
