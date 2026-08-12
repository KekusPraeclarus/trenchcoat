---
description: Research queue lifecycle - how candidates from scans, narrative transitions, new-pool feed, alpha digestion, and chat become bounded research runs. Schema, dedupe, priority, revisit handling, expiry.
scope: module
status: active
last_verified: 2026-08-12
read_when:
  - Editing candidate enqueueing, the research job trigger, narrative bridge, social cashtag bridge, new-pools enqueue, or revisit/expiry handling.
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
confirm, narrative bridge, social-cashtag bridge, new-pools enqueue, dequeue on
cron/`runOperatorResearchNow`, expiry sweep). Agent sessions read the queue,
never write it (INV-S10).

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
  "trigger": "social | new-pools | narrative | revisit | operator | wallet-convergence",
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
3. `wallet-convergence` entries from ≥4 tracked wallets buying a fresh token
4. `narrative` entries from a newly observed narrative or a transition to `peaking`
5. Independent-cluster count (descending)
6. Explicit `priority`, then `firstSeen` ascending

Security `fail` entries become terminal `rejected` and never reach an agent
session. Gate runs in `runOperatorResearchNow` before synthesis.

## Lifecycle rules

- **Daily cap** — dequeue respects `config.research.daily_cap` via
  `completedToday` (default 3), after day rollover on first touch
- **Operator path** — Telegram confirm or `tc research <subject>` calls
  `enqueueOperatorResearch` / `runOperatorResearchNow` under the workspace lock.
  After resolution, the host reuses DexScreener pairs from resolve and collects
  market/security, cached FOMO context, optional Discord wallet-signal context
  (`discord-wallet-context`, ADR 035), and bounded X search concurrently before
  the network-denied research passes.
- **Cron path** — `tc run research` reserves one due entry (kept in-file as
  `researching`), assembles a full dossier (`meta`, `market-dex`,
  `security-gate`, optional socials) via `collectResearchDossier`, then runs the
  same deep-research passes as the operator path. Empty queue, pending-not-due,
  or exhausted daily cap appends `archive/skips/research.jsonl` and returns
  `runId: "none"` (no run directory). `tc precheck research` is a lock-free peek
  only — authoritative expire/dequeue/save still happens under the workspace lock
  inside `runJob` (dequeue mutates status to `researching`). Host Tavily mid-pass
  may write extra inbox snapshots after the first agent pass (queries run
  concurrently under `max_queries_per_run`, stable `web-tavily-{index}` names) —
  `run.ts` **defers** `preArchiveRun` until after `runResearchPasses` for cron
  research so those files are frozen before proposals/verifier (operator
  research archives after passes the same way)
- **Immediate drain** — when social nominations, social-cashtag bridge,
  new-pools bridge, narrative bridge, fomo-signal, or discord-wallet
  buy-convergence enqueue at least one entry, `scheduleResearchDrain` kicks a
  host pump after the parent run releases the workspace lock (does not nest
  under the same lock). Hourly launchd `research` remains a backstop for
  anything left pending
- **Narrative bridge** — after `narrative-scan` integrity succeeds,
  `bridgeNarrativeTickers` deterministically extracts bounded ticker candidates
  from explicit `tickers` fields and cashtags (`$TICKER`) only — never bare
  uppercase/title words, and never reserved chain-native/generic symbols
  (`SOL`, `ETH`, `USDC`, …). It resolves survivors and writes the queue once.
  Ambiguous tickers remain `ambiguous` with a bounded shortlist and never launch
  research (excluded from actionable dequeue). A one-time migration receipt
  (`archive/migrations/generic-chain-symbol-v1.json`) marks historical
  auto-generated ambiguous narrative generics as `rejected` with reason
  `generic-chain-symbol` without deleting history. This bridge never writes the
  watchlist, ledger, or decisions
- **Social research nominations** — usable `list-scan` / `farcaster-scan` runs may
  propose `reports/<run-id>/research-candidates.json`. The host validates sealed
  same-run inbox evidence, requires a verbatim canonical `chain`/`tokenAddress`
  supported by ≥2 independent authors/clusters, and enqueues at most three
  `trigger: "social"` entries. Ticker-only, invented, malformed, expired,
  duplicated, or over-cap nominations are receipted and rejected. Nominations may
  consume research budget but never write watchlist, decisions, ledger, or wallets
- **Social cashtag bridge** — after `list-scan` / `farcaster-scan` integrity,
  `bridgeReadySocialCashtags` scans sealed social inbox for `$TICKER` (skips
  promotional text when configured). It merges independent authors into
  `state/social-cashtag-clusters.json` across runs. When a cluster reaches
  `research.social_cashtag_bridge.min_authors` (default 2) inside
  `window_days`, the host resolves and enqueues `trigger: "social"` (cap
  `max_enqueues_per_run`). Ambiguous shortlists may call shared
  `disambiguateShortlist` under `research.disambiguation_daily_cap`. Generic
  chain symbols stay rejected. The CA fast lane above stays unchanged
  (ADR 046)
- **New-pools bridge** — after `list-scan` collect, `enqueueNewPoolsResearch`
  takes security-pass survivors from the GeckoTerminal feed (including MQ-fail
  items) and enqueues `trigger: "new-pools"` under run/day caps. `shadow_mode`
  writes receipts only. Rejects and accepts append discovery-log rows
  (ADR 046, collectors.md)
- **Telegram alpha bridge** — `telegram-alpha` seals message bodies into inbox,
  then the host (`telegram-alpha-research.ts`) enqueues from a **single**
  allowlisted-channel message: verbatim CA, or cashtag + chain-hint resolution
  (DexScreener + optional `composer-2.5-fast` disambiguation). Cap 3/run;
  `clusterCount: 1`. Ambiguous shortlists park without launching research.
  `scheduleResearchDrain` runs after accepted enqueues. Completed resolved
  research with a clear trade, watch, or avoid conclusion proposes one market
  outbox item, including negative findings; ambiguous evidence stays silent. See
  [ADR 015](../adr/015-telegram-alpha-research.md) and
  [ADR 023](../adr/023-narrative-development-and-research-broadcast.md) (general
  `research` job now shares the same mandatory-outbox rule)
- **Fomo signal bridge** — `fomo-signal-scan` may enqueue `trigger: "social"`
  entries from feed/alerts/derived convergence when config + FAFO gates pass and
  `shadow_mode=false`. Canonical resolution is required before enqueue; cluster
  count is unique mapped handles. Native/wrap gas mints (`So1111…` WSOL, WETH,
  WBNB, …) and reserved chain symbols (`SOL`, `ETH`, …) are never enqueued.
  Default cap is `signal_scan.max_enqueues_per_day` (3). See
  [knowledge/fomo-family.md](../knowledge/fomo-family.md)
- **Wallet convergence bridge** — after `wallet-scan-*`, host may enqueue
  `trigger: "wallet-convergence"` (priority 70) when ≥4 event-time `tracking`
  wallets buy the same fresh token. Independent of the unverified alert path;
  capped by `wallets.convergence.max_enqueues_per_day`. See
  [smart-wallets.md](./smart-wallets.md) and [ADR 020](../adr/020-runner-wallet-discovery.md)
- **Expiry** — pending/ambiguous entries past `expiresAt` are swept
- **Ambiguous** — held when DexScreener resolution cannot bind a canonical
  identity; operator should resubmit `chain:address`
- **Web search** — optional host-mediated Tavily Search from validated
  `web-search-requests.json` queries only (never model URLs); key
  `TAVILY_API_KEY` stays host-only; failures are isolated per query and all
  snapshots settle before pass 2
- **X search** — optional host-mediated burner-profile search
  (`config.research.twitter_search`); agents never open X themselves.
  Farcaster is not part of the research dossier path.

## Health / status surfaces

`src/orchestrator/health.ts` reports **actionable** depth (status `pending` with
a runnable resolution) separately from **ambiguous** parked entries. Empty
actionable depth and non-zero ambiguous counts are warnings on `tc status` /
Telegram `/status` and keep daily `review` in scope (with skip-ledger counts)
even when no sealed agent reports exist. Host precondition skips still append
`archive/skips/research.jsonl` (`queue-empty` / `daily-cap` / `queue-pending`)
and those reasons roll into the shared skip-count snapshot.

## Invariants touched

INV-S9 (gate-failed tokens rejected before track), INV-S6 (provenance),
INV-S10 (queue host-only), INV-S15 (lock for writers), INV-R4 (no chat fetches).
