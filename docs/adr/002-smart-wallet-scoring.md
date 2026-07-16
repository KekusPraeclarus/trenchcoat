---
description: ADR — wallet score is 80% deterministic + 20% bounded fail-closed LLM vote.
status: accepted
date: 2026-07-16
---

# ADR 002 — Smart-wallet scoring

## Context

Purely deterministic scoring misses qualitative structure; unbounded LLM scoring
is un-auditable and injectable via social/on-chain narrative.

## Decision

```text
blended = 0.80 * deterministic + 0.20 * boundedLlmVote
```

Hard exclusions are absolute. The voter is an isolated session over a frozen
evidence card; malformed output → neutral 50. Weight changes require a reviewed
config/doc change; the system never self-tunes.

## Consequences

- Every vote archives input hash, prompt version, raw output, and contribution
- Promotion/drop thresholds use both deterministic and blended floors
- Runtime agents cannot write wallet state

## Implementation note (2026-07-16)

Scoring maths live in `src/wallets/scoring.ts` (INV-S19 PARTIAL). Lifecycle
event builders exist in `src/wallets/lifecycle.ts`, but no caller yet persists
transitions or stages `wallet.lifecycle` router events (INV-S20 GAP). Decision
stands; wiring is incomplete.
