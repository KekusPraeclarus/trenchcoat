---
description: ADR — wallet score is 80% deterministic + 20% bounded fail-closed LLM vote.
status: accepted
date: 2026-07-16
last_verified: 2026-07-20
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
- Runtime agents cannot write wallet state, nominate wallets, or influence scores

## Implementation note (2026-07-18)

Scoring maths live in `src/wallets/scoring.ts`. Discovery/scan/review host jobs
are wired (`wallet-discovery`, `wallet-scan-*`, `wallet-review`). Operator seed
and autonomous candidates both write host-only `state/wallets.json`.
Discovery and scan jobs may launch a `wallet-evidence` agent over frozen,
untrusted wallet snapshots. Its bounded `wallet-evidence.md` report is archived
as advisory token research only and is never applied to wallet state, scores,
cursors, or lifecycle transitions. `wallet-review` remains host-only and
archives per-vote `evidenceCardHash`, `voterPromptHash`, bounded raw output,
parsed score, and contribution to `archive/wallets/<runId>-review.json`.
`wallet-review` stages `wallet.lifecycle` router events unless canary-blocked
(INV-S20 PARTIAL — live E2E still gated on provider keys).
