---
description: ADR — Discord idea-tracking alerts are research-first and gated; no loose chatter pings.
scope: project
status: accepted
last_verified: 2026-07-21
---

# ADR 019 — Gated Discord tracking alerts

## Context

ADR 018 shipped NL idea-tracking with durable match batches. The first live
alerts fired on thematic scan chatter (`I see talk of …`) without verifying a
ticker/CA or requiring solid deep research. That was too loose: members got
reply-threaded pings for project-name talk that was not an actionable token.

Operators required: verify ticker or contract in the matched evidence, run deep
research on that token, notify only when research is solid, include the full
research body, and never reply to the original tracking request when presenting
the alert. The idea label in the header is the stored `shortLabel` (not a
narrative slug / deslug).

## Decision

- Amend ADR 018 delivery. Match output is
  `{trackingId, candidateProvenance, tokenQuery, reason}`. Host binds provenance
  to one sealed candidate and accepts only CA / `$TICKER` / bare ticker present
  in that text; project-name-only guesses fail closed.
- Resolve `tokenQuery` with the existing host research resolver. Empty,
  unsupported, or ambiguous resolution is silent.
- Scan/FC hits create no Discord message. They enqueue silent
  `origin: "tracking"` deep research (no ✅, no terminal error reply, no ordinary
  research reply).
- **Initial notify** only when `mainTrackEligible === true` (existing
  `evaluateResearchSubscribe` gate: resolved identity, non-pending/non-hard-fail
  security, matching `track` proposal, contextual mint rule).
- **Reconsideration:** after non-qualification, accumulate three unique later
  provenance IDs (duplicate provenance and byte-normalized text count once). On
  the third, run path-only `composer-2.5-fast` mention review over sealed
  mentions plus host source trust rows. Reject → `blacklistedUntil = now + 7d`.
  Approve → one fresh deep research; alert may include a security hard-fail
  warning. Watch subscribe and main-watchlist promote keep their existing gates
  (never bypassed by the three-mention path).
- Qualified alert copy is a **channel message** (never `sendReply` to the track
  request): `@user I found a token matching <shortLabel>` then the full promoted
  deep-research body. Only the first chunk mentions the owner.
- Dedupe key is `(trackingId, chain, lowercase tokenAddress)`. Mark
  `matchedSubjects` only after a successful delivered alert.
- Research-origin match batches carry host `mainTrackEligible` + identity;
  missing qualification metadata fails closed.

## Consequences

- Fewer false pings; higher research cost per true match (silent deep research
  before any alert).
- Operators debugging “why no ping?” must check resolve outcome,
  `mainTrackEligible`, `awaiting-mentions` count, blacklist, and quota — not only
  match batches.
- Schema-1 `tracking.json` stays additive; delivery statuses expand
  (`research-pending`, `awaiting-mentions`, `qualified-pending`, `suppressed`, …).
- INV-D6/D7 claims shift from subject-string ping to canonical-token
  qualification (see INVARIANTS).
- Live `~/.trenchcoat/config.json` may still hold an explicit
  `tracking.enabled` value that overrides the schema default — flipping the
  default alone does not enable a previously disabled live install.

## Alternatives considered

- Keep match-first `I see talk of` pings → rejected after live noise.
- Cashtag-only ticker evidence → rejected; bare tickers allowed when present in
  the bound candidate; chain/CA inference only via host resolver.
- Permanent non-retry after failed solid gate → rejected; three-mention review
  with 7-day blacklist on review reject.
- Deslug `shortLabel` for display → rejected; render stored label after sanitize.

## Follow-ups

- Archive INV-D8 live intent/match corpus metrics.
- Optional Discord nonce reconciliation (INV-D7 PARTIAL).

## References

- ADR 018 (idea-tracking foundation)
- [architecture/discord-tracking.md](../architecture/discord-tracking.md)
- INV-D3–D8 in [INVARIANTS.md](../INVARIANTS.md)
