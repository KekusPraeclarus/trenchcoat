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
