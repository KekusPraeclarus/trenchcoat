---
description: Research queue lifecycle - how candidates from list-scan, new-pool feed, alpha digestion, and chat become bounded research runs. Schema, dedupe, priority, revisit handling, expiry.
scope: module
status: draft
last_verified: 2026-07-16
read_when:
  - Editing candidate enqueueing, the research job trigger, or revisit/expiry handling.
---

# Research queue

## Purpose

`list-scan` and the new-pool feed surface more candidates than the research
budget (≤ a few runs/day) can cover. The queue is the deterministic buffer
between discovery and research: host-owned, bounded, auditable, and the only
path into a `research` run.

## Storage

`agent/state/research-queue.json` — array of entries, **written only by
deterministic orchestrator code** (enqueue from scan outputs, dequeue on run
start, expiry sweep). The agent proposes candidates in its scan report output
contract; the orchestrator validates each proposal through resolution
(token-resolution.md) and the chain registry before it becomes an entry.
Agent sessions read the queue, never write it.

## Entry schema

```json
{
  "id": "rq-2026-07-16-001",
  "chain": "solana",
  "token_address": "…",
  "pair_address": "…",
  "symbol_display": "TICKER",
  "resolution": "resolved",
  "first_seen": "2026-07-16T09:00:00Z",
  "enqueued_by": "run:list-scan-2026-07-16-0800",
  "trigger": "social | new-pools | revisit | operator",
  "provenance": ["telegram:channelname", "twitter:@handle"],
  "cluster_count": 2,
  "security": { "status": "pass | fail | pending", "flags": [] },
  "status": "pending | ambiguous | researching | done | expired | rejected",
  "revisit_after": null
}
```

Dedupe key: `(chain, token_address)`. A re-surfaced candidate updates the
existing entry (appends provenance, bumps `cluster_count`) rather than creating
a duplicate.

## Priority

Deterministic sort at dequeue time, no model involvement:

1. `operator` trigger (chat/CLI requests jump the queue)
2. `revisit` entries whose `revisit_after` has passed
3. Independent-cluster count (descending) — corroborated attention first
4. `first_seen` (ascending) — earliest wins ties

Security `fail` entries are terminal `rejected` (the dock pipeline has already
run, orchestrator.md) — they never reach an agent session. `pending` security
is resolved by running the gate at dequeue, before the session starts.

## Lifecycle rules

- **Daily cap** — the scheduler dequeues at most N (default 3) per day;
  the cap is config (CONFIG.md), enforced at dequeue, not by the agent
- **Revisit** — a `revisit` verdict from a research run re-enqueues the entry
  with `revisit_after` set from the verdict (default +7d) and
  `trigger: "revisit"`. One live entry per token — a revisit replaces, never
  duplicates
- **Expiry** — `pending` entries older than 14 days expire; expired and
  rejected entries are logged to the host-side discovery log (audit-metrics.md)
  before removal, so counterfactual pricing covers what we *didn't* research
- **Ambiguous** — held in queue, not counted against the cap; promoted to
  `pending` when resolution succeeds — deterministically, via model-judged
  disambiguation from the dossier (token-resolution.md), or by operator CA —
  and expired on the same 14-day clock. A model-confirmed binding is validated
  against the dossier shortlist and written by the orchestrator (INV-S16)

## Discovery audit record

Before removal, the host appends one immutable record containing queue id,
canonical identity (or unresolved candidate set), first-seen/event timestamps,
trigger, deduped provenance/clusters, terminal reason and typed sub-reasons,
queue rank/cap pressure, gate/config/feature versions, market observed time,
context price/liquidity, and hashes referencing the exact feature/candle dossier.
It also records whether the candidate was never eligible, eligible but capacity
blocked, expired, scanner-pending, ambiguous, or rejected.

Raw social text and candle arrays are not copied into the log; archive hashes
reference their immutable originals. This is enough to stratify false blocks,
queue-cap misses, resolver abstains, and stale-data loss without turning the
discovery log into a second inbox.

## Invariants touched

INV-S9 (gate-failed tokens can't be tracked — enforced here at dequeue and
again post-run), INV-S6 (entries carry provenance), INV-S10 (the queue file is
host-only and joins the post-run "unchanged by agent sessions" check).
