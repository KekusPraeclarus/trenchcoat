---
description: Smart-wallet discovery, deterministic scoring, bounded LLM vote, promotion/drop hysteresis, and mandatory lifecycle router events.
scope: project
status: active
last_verified: 2026-07-16
read_when:
  - Editing wallet collectors, scoring, lifecycle transitions, or wallet router events
---

# Smart wallets

Solana truth is Helius finalized standard RPC (signatures + transaction/balance
deltas). EVM truth is Infura HTTP/WSS on Ethereum and Base with finalized-block
cursors and `removed` reorg handling. BSC and Robinhood remain token-trackable
but wallet tracking is fail-closed unless a kickoff probe proves capability.

No signing libraries. No transaction submission. Read-only codecs only (INV-A1).

## Lifecycle

1. Operator seeds enter as `tracking-probation` with one `wallet.lifecycle added`
   event (`reasonCode: operator-seed`).
2. Autonomous early-buyer discovery stages candidates; promotion requires the
   config thresholds (effective buys, distinct tokens, coverage, scores, hit
   bounds, median excess, rug exposure, recency).
3. Hard exclusions are absolute and non-overridable by the LLM vote: contracts,
   programs, routers/pools/bridges/CEX/team/deployer, wash/self-transfer,
   security-failed tokens, failed txs, unfinalized or unpriceable actions.
4. Drops follow idle/rug/coverage/score hysteresis; re-add needs cooldown + new
   eligible events.
5. Every transition is immutable, idempotent, git-committed before dispatch, and
   emits exactly one durable router event with a host-rendered one-liner.
6. Reviews apply at most `max_transitions_per_review` per run; excess stays queued.

## Scoring

```text
deterministic =
  0.35 * posteriorHitQuality +
  0.25 * medianExcessQuality +
  0.15 * leadTimeQuality +
  0.15 * drawdownAndRugQuality +
  0.10 * coverageDiversityActivity

blended = 0.80 * deterministic + 0.20 * boundedLlmVote
```

The isolated wallet voter receives only a frozen evidence card and must return
`{score_0_100, verdict, reason_code}`. Unknown/malformed/inconsistent output
becomes neutral 50. The model cannot bypass a hard gate, mutate state, format
router prose, or exceed 20% influence. Input hash, prompt version, output, token
usage, and contribution are archived.

Runtime research agents may treat wallet signals as token evidence only. They
cannot nominate, score, add, or drop wallets.

See ADR 002 for the scoring decision.
