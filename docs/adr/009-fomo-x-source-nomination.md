---
title: Fomo leaderboard X-source nomination
description: ADR — Fomo may nominate X accounts only; host merge + probation gate membership and follows.
status: accepted
date: 2026-07-19
last_verified: 2026-08-17
---

# ADR 009 — Fomo X-source nomination

## Context

Fomo leaderboard traders often have linked or same-handle X accounts that may
be useful shillers or narrative sources. Classification must not mutate X lists
or follows directly.

## Decision

1. Host upserts nominations into `state/x-source-nominations.json` from dated
   leaderboard observations.
2. `fomo-x-source-review` scrapes a bounded history and launches one isolated
   sandboxed agent per candidate. Output is a strict JSON classification only.
3. Host merge fail-closes on missing evidence IDs. `shiller`/`both` require
   deterministic historical call extraction and existing source-list gates
   before managed-list promotion (`discoveredFrom: fomo-leaderboard`). Call
   extraction unions sealed X-post CAs with dated FOMO profile swap buys
   (quote→meme only) for the entry bar. Only X-post CAs enter the call log.
   Promotion scores those X-post outcomes. Tickers and profile wallets do
   not count.
4. `narrative`/`both` enter a 14-day utility probation in
   `state/x-narrative-sources.json`. Follows use the existing X engagement
   executor only after measured contribution thresholds.
5. Historical posts are never reused as live narrative evidence.

## Consequences

- Dual tracks stay independent (`both` must pass both).
- Agent classification cannot call X, write lifecycle files, or follow.
- Kill switches: `fomo.enabled`, `fomo.x_source_review.enabled`,
  `fomo.narrative_source_probation.enabled`.
