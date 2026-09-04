---
title: FOMO platform follows stay separate from X review
description: ADR — follow FOMO traders on fomo.family to see buys. Review X only when a linked account has enough posts to classify as shill or narrative.
status: accepted
date: 2026-08-17
last_verified: 2026-08-17
---

# ADR 048 — FOMO follows vs X review

## Context

FOMO leaderboard traders are useful because of their FOMO buys. Their X
accounts are a second question. Mixing FOMO swaps into X shiller entry filled
the nomination queue with weak X history.

## Decision

1. `fomo-trader-sync` may follow FOMO handles on fomo.family. State lives in
   `state/fomo-follows.json`. Caps are `max_follows_per_run` and
   `max_following`. Shadow mode writes no follows.
2. Follow mutations use a dedicated browser context with `mutationMode`.
   The session boots the token route, then opens `/profile/{handle}`.
   Trades, transfers, and wallet writes stay blocked (INV-S19, INV-S31).
   An unverified follow cools that handle for 24 hours.
3. X nominations require an explicit FOMO profile X link. Same-handle
   fallback does not enter pending.
4. X review classifies posts only. Shiller entry is X-post CAs (10 / 5).
   The host does not skip the classification agent only because X CAs are
   under 10. A narrative account can have strong posts and few CAs.
   Thin post sample (`min_posts` / `min_active_days`) still skips the agent
   and does not burn the daily review cap. Managed list is for shills. X
   follow is for narratives after probation.
5. FOMO traders keep scoring on FIFO `fomo-trader-scores.json`.

## Consequences

- The FOMO feed can show followed-trader buys without an X review.
- Thin X accounts do not consume classification budget as FOMO-padded shills.
- Narrative review still needs enough X posts to classify role.
- Kill switches: `fomo.enabled`, `fomo.shadow_mode`, `fomo.follows.enabled`,
  `fomo.x_source_review.enabled`.

## Alternatives considered

- Union FOMO profile buys into the shiller 10/5 bar. Rejected. It filled
  pending with accounts that had no useful X posts.
- Skip the X classification agent when X-post CAs are under 10. Rejected.
  That blocks narrative classification.
- Follow leaderboard traders on X from FOMO sync. Rejected. X follow stays
  behind narrative probation (ADR 009, INV-S21).
- Write FOMO profile addresses into `wallets.json`. Rejected (INV-S19).

## Follow-ups

- INV-S31 stays PARTIAL until live FOMO follows are operator-verified.
- Schema 28 migrate turns `follows.enabled` on when FOMO is already live
  and not in shadow mode.
