---
description: ADR — X source discovery uses two immutable operator lists + FYP; membership of one private managed list is host-deterministic only.
status: accepted
date: 2026-07-16
last_verified: 2026-07-20
---

# ADR 004 — Dynamic X list lifecycle

## Context

A single curated list cannot both stay operator-owned and improve from FYP
discoveries. Letting the runtime agent add/remove X members would couple
membership to untrusted social text and model judgment (INV-S7/S12 risk).

## Decision

1. Config carries **exactly two immutable** `twitter.operator_list_urls` plus
   `scrape_home: true`. Operator lists are never mutated by the bot.
2. Accounts first seen on FYP **or either operator list** enter host-owned
   **probation** in `agent/state/source-lifecycle.json` (separate from
   `sources.json` scores).
3. Promotion/demotion is **deterministic host code** over lagged, settled,
   direct bullish raw-CA outcomes only (INV-S21). Models, engagement, follower
   counts, and same-window settlements cannot promote.
4. One private **managed list** is created once
   (`tc auth twitter --create-managed-list`); only its ID/URL are persisted.
5. Normal scrapers remain read-only. A separate host synchronizer may mutate
   membership of that single list ID after confinement checks (INV-R2).

## Consequences

- `source-list-review` is host-only (no agent session); sequence is freeze
  score cutoff → commit transitions → sync X → journal receipt
- Retries use immutable transition IDs; at most
  `max_transitions_per_review` (default 10) apply per review; excess transition
  ids queue until a later review applies them
- FYP likes/follows are owned by the runtime agent for narrative/sentiment feed
  training (INV-S22), default-throttled to 2 likes / 10 minutes; they never write
  managed-list membership
- Live acceptance still needs the burner session and both operator list URLs
  configured; dry-run via `tc source-list review --dry-run`
- **Implementation note (2026-07-18):** transition engine, synchronizer, and
  source-call settlers are wired; `outcomes-settle` / audit use live
  DexScreener→GeckoTerminal bars. INV-S21 remains PARTIAL until live pricing
  E2E is green — empty-archive reviews are still not authoritative promotions.

## Enforcement

- `src/sources/lifecycle.ts`, `src/collectors/twitter/managed-list.ts`
- `docs/architecture/source-lifecycle.md`, INV-S21 (PARTIAL), INV-R2
