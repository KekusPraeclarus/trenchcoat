---
title: Fomo leaderboard X-source nomination
description: ADR — Fomo may nominate X accounts only; host merge + probation gate membership and follows.
status: accepted
date: 2026-07-19
last_verified: 2026-08-17
---

# ADR 009 — Fomo X-source nomination

## Context

Fomo leaderboard traders often have a linked X account that may be a useful
shiller or narrative source. Classification must not mutate X lists or X
follows directly. FOMO-platform follows are a separate host track (ADR 048).

## Decision

1. Host upserts nominations into `state/x-source-nominations.json` from dated
   leaderboard rows that carry an explicit FOMO profile X link. Same-handle
   fallback does not enter the pending queue. FOMO platform follows are a
   separate host track (ADR 048).
2. `fomo-x-source-review` scrapes a bounded X history and launches one isolated
   sandboxed agent per candidate. Output is a strict JSON classification only.
   The job does not scrape FOMO profile buys.
3. Host merge fail-closes on missing evidence IDs. `shiller`/`both` require
   deterministic historical X-post call extraction and existing source-list
   gates before managed-list promotion (`discoveredFrom: fomo-leaderboard`).
   Entry is sealed X-post CAs only (10 calls / 5 tokens). FOMO buys do not
   count. Only X-post CAs enter the call log. Promotion scores those X-post
   outcomes. Tickers and profile wallets do not count.
4. `narrative`/`both` enter a 14-day utility probation in
   `state/x-narrative-sources.json`. Follows use the existing X engagement
   executor only after measured contribution thresholds.
5. Historical posts are never reused as live narrative evidence.

## Consequences

- Dual tracks stay independent (`both` must pass both).
- Agent classification cannot call X, write lifecycle files, or follow.
- Kill switches: `fomo.enabled`, `fomo.x_source_review.enabled`,
  `fomo.narrative_source_probation.enabled`.
