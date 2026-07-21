---
description: ADR — Discord idea-tracking chain constraint and watch-update quality gate.
scope: project
status: accepted
last_verified: 2026-07-21
---

# ADR 021 — Tracking chain constraint + watch quality gate

## Context

Live idea-tracking matched a bare `$AI` ticker against a request for AI tokens
on Robinhood chain, resolved a Solana mint, ran silent research that said walk,
still Discord-watch-subscribed the token, and later posted a six-hour material
update with no reply thread (synthetic research message id) and no owner ping.

Root causes:

1. Tracking requests stored only free-text `description` / `shortLabel`. Resolve
   had no `chainHint`, so DexScreener could land on any chain.
2. Discord watch subscription required only non-hard-fail security
   (`evaluateDiscordWatchSubscribe`). The validated track verdict
   (`mainTrackEligible`) gated alerts and main promote, not member updates — so
   walk/ignore tokens still generated watch updates.

## Decision

1. **Optional request chain.** Intent classifier may emit `chain` on `track`.
   Host normalizes via `normalizeChainSlug` (aliases: RH→robinhood, SOL→solana,
   ETH→ethereum, HL/HYPE→hyperliquid, …). Unknown → omit (no constraint).
   Persist on `TrackingRequestRecord.chain`.
2. **Hard cross-chain reject.** Match worker passes `chainHint` into
   `resolveResearchSubject` and drops any hit whose resolved (or
   research-origin) chain differs from the request chain via
   `trackingChainAllows`. No stored chain → any chain allowed.
3. **Watch subscribe quality gate.** Both direct-research and tracking-origin
   subscribe paths require `mainTrackEligible` in addition to
   `subscribeAllowed` / non-hard-fail. Only tokens research judges worth
   watching get baselines and six-hour updates.

## Consequences

- "AI on RH" cannot silently bind a Solana `$AI`.
- Useless walk/ignore research no longer spams the channel with material updates.
- INV-D1 subscribe claim updated to require the track verdict.
- Existing wrong-chain watch subscriptions are not auto-pruned (ops).

## Alternatives considered

- Soft prefer-chain but allow other chains → rejected; user named a chain.
- Suppress individual watch updates by thesis text → rejected; gate at
  subscribe is clearer and avoids useless baselines.
- Require an explicit chain on every tracking request → rejected; chainless
  thematic watches remain valid.

## References

- [architecture/discord-tracking.md](../architecture/discord-tracking.md)
- [architecture/discord-research.md](../architecture/discord-research.md)
- ADR 018, ADR 019, INV-D1
