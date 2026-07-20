---
description: ADR — Active mint authority is caution-only; host blocks track only for mintable memecoins after model classification.
scope: project
status: accepted
last_verified: 2026-07-20
---

# ADR 011 — Contextual mint security

## Context

GoPlus `is_mintable` and RugCheck mint authority were scanner hard-fails. That
blocked legitimate projects whose supply is minted on a schedule (capped
emissions, PoW rewards, vesting) — e.g. TIG on Base. Operators still want
mintable **memecoins** blocked automatically.

## Decision

- Treat `mintable` / `mint-authority` as **caution flags** only — they never set
  scanner `hardFail` alone (same class as `low-lp-lock`).
- Research always writes a structured `DecisionProposalFile` with
  `projectClassification` (`memecoin` | `utility` | `infrastructure` | `unknown`)
  and, when mint is active, `mintAssessment { active, justified, rationale }`.
- Host validation (`mintTrackBlockReason` in proposals; `evaluateResearchSubscribe`
  for Discord) rejects `track` / subscribe when mint is active **and**
  classification is `memecoin`, or when classification is missing. Justified
  non-meme mints may track.
- Contextual rejection does **not** trigger rug-dock — INV-S12 stays tied to
  typed scanner hard-fails only.
- Discord no longer auto-subscribes on “not hard-fail”; subscribe requires an
  accepted `track` verdict (fail closed on missing/malformed proposals).

## Consequences

- INV-S9 includes the contextual mint rule alongside scanner hard-fail.
- Model misclassification of a mintable meme as `utility` can pass host checks —
  skills require honest classification; audit metrics should watch caution-flag
  loss lift for mint tracks.
- Runtime skill copies under `~/.trenchcoat/agent` and
  `~/.trenchcoat/discord/agent` still need manual sync after skill edits.

## References

- [architecture/security-gate.md](../architecture/security-gate.md)
- [architecture/discord-research.md](../architecture/discord-research.md)
- INV-S9 / INV-S12 in [INVARIANTS.md](../INVARIANTS.md)
- `src/collectors/market/security.ts`, `src/orchestrator/research-verdict.ts`
