---
description: Research queue lifecycle - how candidates from scans, narrative transitions, new-pool feed, alpha digestion, and chat become bounded research runs. Schema, dedupe, priority, revisit handling, expiry.
scope: module
status: active
last_verified: 2026-07-18
read_when:
  - Editing candidate enqueueing, the research job trigger, narrative bridge, or revisit/expiry handling.
---

# Research queue

## Purpose

`list-scan` and the new-pool feed surface more candidates than the research
budget (≤ a few runs/day) can cover. The queue is the deterministic buffer
between discovery and research: host-owned, bounded, auditable, and the only
path into a `research` run (plus operator `tc research` / Telegram confirm).

## Storage

`agent/state/research-queue.json` — array of entries, **written only by
deterministic orchestrator code** (enqueue from scan outputs or operator
confirm, narrative bridge, dequeue on cron/`runOperatorResearchNow`, expiry sweep). Agent sessions
read the queue, never write it (INV-S10).

Telegram confirmation state is **not** stored here — it lives in
`~/.trenchcoat/pending-research.json` until confirm, then the host enqueues.

## Entry schema (implemented)

```json
{
  "schema": 1,
  "queueId": "rq-20260717-ab12",
  "subject": "solana:So111…",
  "chain": "solana",
  "tokenAddress": "…",
  "pairAddress": "…",
  "symbolDisplay": "TICKER",
  "resolution": "pending | resolved | model-confirmed | ambiguous | unsupported-chain",
  "priority": 100,
  "firstSeen": "2026-07-17T09:00:00.000Z",
  "enqueuedAt": "2026-07-17T09:00:00.000Z",
  "enqueuedBy": "rr-…",
  "trigger": "social | new-pools | narrative | revisit | operator",
  "provenance": ["operator:telegram:rr-…"],
  "clusterCount": 1,
  "security": { "status": "pass | fail | pending", "flags": [] },
  "status": "pending | ambiguous | researching | done | expired | rejected",
  "expiresAt": "2026-07-31T09:00:00.000Z",
  "revisitAfter": null,
  "reason": "telegram confirmed research"
}
```

Dedupe key: `(chain, tokenAddress)` when both are present, else normalized
`subject`. A re-surfaced candidate merges provenance / priority rather than
duplicating.

File may also carry `completedToday: { day, count }` for daily-cap accounting.
On first touch of a new UTC day (`enqueue` / `dequeue` / `expire` /
`recordCompletedToday`), `rolloverCompletedToday` resets the stamp to
`{ day, count: 0}` so a stale prior-day counter cannot block the cap.

## Priority

Deterministic sort at dequeue time, no model involvement:

1. `operator` trigger (chat/CLI requests jump the queue)
2. `revisit` entries whose `revisitAfter` has passed
3. `narrative` entries from a newly observed narrative or a transition to `peaking`
4. Independent-cluster count (descending)
5. Explicit `priority`, then `firstSeen` ascending

Security `fail` entries become terminal `rejected` and never reach an agent
session. Gate runs in `runOperatorResearchNow` before synthesis.

## Lifecycle rules

- **Daily cap** — dequeue respects `config.research.daily_cap` via
  `completedToday` (default 3), after day rollover on first touch
- **Operator path** — Telegram confirm or `tc research <subject>` calls
  `enqueueOperatorResearch` / `runOperatorResearchNow` under the workspace lock.
  After resolution + security gate, the host scrapes bounded X search for
  sentiment/popularity snapshots before the network-denied research passes.
- **Cron path** — `tc run research` reserves one due entry (kept in-file as
  `researching`), assembles a full dossier (`meta`, `market-dex`,
  `security-gate`, optional socials) via `collectResearchDossier`, then runs the
  same deep-research passes as the operator path. Empty queue, pending-not-due,
  or exhausted daily cap appends `archive/skips/research.jsonl` and returns
  `runId: "none"` (no run directory). `tc precheck research` is a lock-free peek
  only — authoritative expire/dequeue/save still happens under the workspace lock
  inside `runJob` (dequeue mutates status to `researching`). Host Tavily mid-pass
  may write extra inbox snapshots after the first agent pass — `run.ts` **defers**
  `preArchiveRun` until after `runResearchPasses` for cron research so those
  files are frozen before proposals/verifier (operator research archives after
  passes the same way)
- **Narrative bridge** — after `narrative-scan` integrity succeeds,
  `bridgeNarrativeTickers` deterministically extracts bounded ticker candidates,
  resolves them, and writes the queue once. Ambiguous tickers remain
  `ambiguous` with a bounded shortlist and never launch research. This bridge
  never writes the watchlist, ledger, or decisions
- **Expiry** — pending/ambiguous entries past `expiresAt` are swept
- **Ambiguous** — held when DexScreener resolution cannot bind a canonical
  identity; operator should resubmit `chain:address`
- **Web search** — optional host-mediated Tavily Search from validated
  `web-search-requests.json` queries only (never model URLs); key
  `TAVILY_API_KEY` stays host-only
- **X search** — optional host-mediated burner-profile search
  (`config.research.twitter_search`); agents never open X themselves

## Invariants touched

INV-S9 (gate-failed tokens rejected before track), INV-S6 (provenance),
INV-S10 (queue host-only), INV-S15 (lock for writers), INV-R4 (no chat fetches).
