---
description: Smart-wallet discovery, deterministic scoring, bounded LLM vote, promotion/drop hysteresis, and mandatory lifecycle router events.
scope: project
status: active
last_verified: 2026-08-15
read_when:
  - Editing wallet collectors, scoring, lifecycle transitions, or wallet router events
---

# Smart wallets

Solana truth is Helius finalized standard RPC (signatures + transaction/balance
deltas with native/allowlisted quote spend). EVM truth is Infura HTTP on
Ethereum and Base, plus Robinhood Chain public RPC, with finalized-block
cursors, receipt-backed swap-buy classification, block timestamps, and
`removed` reorg handling. Infura pacing uses the shared host gate with
credit-weighted takes and a ~638ms serial min interval (Core 500 credits/s,
`eth_getLogs` 255 — `docs/knowledge/infura.md`). Robinhood Chain uses the throttled
official public RPC (`https://rpc.mainnet.chain.robinhood.com`) and fail-closes
on HTTP 429/5xx. BSC remains wallet-tracking unsupported.

No signing libraries. No transaction submission. Read-only codecs only (INV-A1).

## Lifecycle

1. **Operator seed (optional)** — `tc wallets seed <file>` writes
   `tracking-probation` with `reasonCode: operator-seed`, takes the workspace
   writer lock, and stages one `wallet.lifecycle` router event per transition
   (unless canary blocks external effects). Refuses non-empty `wallets.json`.
   Autonomous discovery can populate an empty file.
   **`tc wallets add-candidates <file>`** merges operator-nominated **`candidate`**
   wallets into existing state (`discoveredFrom: operator-nomination`); no router
   events until review promotes. Same entry schema as seed wallets array.
2. **`wallet-discovery`** — host walks watchlist token identities on
   wallet-supported chains, extracts verified early buyers, stages `candidate`
   wallets, checkpoints resumable cursors in `state/wallets.json`, and
   quarantines any legacy `discoveredFrom: "fomo"` records. A sandboxed
   evidence-only agent may summarize a frozen wallet snapshot, but cannot
   affect this host work.
3. **`wallet-runner-discovery`** — host qualifies fresh GeckoTerminal pools
   (age ≤24h, liquidity ≥$50k, closed 6h return ≥100%, volume ≥$250k), ranks
   the first 25 verified buyers in 30 minutes, and registers `new-pools`
   candidates only after ≥2 runner sightings in 30 days. Defaults
   `enabled: false`, `shadow_mode: true`. State lives in
   `state/wallet-runners.json`.
4. **`wallet-scan-solana` / `wallet-scan-evm`** — host performs incremental
   finalized action scans with separate tip/backfill cursors for candidates
   (30-day backfill); archives verified **buy and sell** outcomes under
   `archive/outcomes/wallet-buy-*.json` (`side`, `providerEventId`,
   `walletStatusAtEvent`). After each scan, host may derive tracked-wallet
   convergence from buys only.
5. **Hard exclusions** — absolute and non-overridable by the LLM vote
   (`src/wallets/exclusions.ts`): contracts, programs, routers/pools/bridges/
   CEX/team/deployer, wash/self-transfer, security-failed tokens, failed txs,
   unfinalized or unpriceable actions. Unknown entity kinds fail closed as
   `contract`. Objective evidence is persisted on `wallets.json` (`exclusions`)
   during runner discovery and applied by `wallet-review` (not test-only maps).
6. **`wallet-review` (host-only)** — lagged settled outcomes → deterministic
   score + bounded voter (neutral 50 on malformed) → promote/drop/re-add with
   hysteresis; caps `max_transitions_per_review`; stages one
   `wallet.lifecycle` router event per applied transition unless canary
   `blockExternalEffects` is set.
7. Reviews apply at most `max_transitions_per_review` per run; excess stays queued.

## Convergence

When ≥4 wallets with event-time status `tracking` buy the same fresh token
(≤24h) within 15 minutes, the host stages a `wallet.convergence` router event
with text prefix `UNVERIFIED WALLET CONVERGENCE` and independently enqueues
research (`trigger: wallet-convergence`, priority 70). Alerts and enqueues
have separate daily caps and a 6h per-token cooldown. Shadow mode logs without
mutating queue/router state.

## Jobs / cadence (config)

| Job | Default cadence |
|---|---|
| `wallet-discovery` | `wallets.discovery_interval_hours` (6h) |
| `wallet-runner-discovery` | `wallets.runner_discovery.interval_minutes` (30m) |
| `wallet-scan-solana` | `wallets.solana_scan_minutes` (5m); ≤`max_wallets_per_scan` (5) per tick |
| `wallet-scan-evm` | `wallets.evm_scan_minutes` (15m); same per-run cap |
| `wallet-review` | daily |

`wallet-scan-*`, `wallet-review`, and `outcomes-settle` are **agent-lock exempt**
at the job wrapper ([ADR 027](../adr/027-improvement-lanes-skip-agent-lock.md),
[ADR 031](../adr/031-wallet-settle-brief-locks-and-ledger.md)). Provider I/O and
archive settlement run unlocked; `wallets.json` / ledger RMW uses a brief
`withAgentWorkspaceLock`. If that lock stays held, settle records `lockDeferred`
and completes; the next cycle retries the pending write. Scans are host-only
(no Cursor session). Round-robin
prefers wallets with the oldest cursors so backfill progresses under the
per-run cap.

## Scoring

Hits and median excess use **FIFO copy-trade `realizedReturn`** (buy bar →
sell bar; open buys unsettled). Horizon 72h fields may still be archived as
diagnostics ([ADR 032](../adr/032-peak-and-copy-trade-metrics.md)).

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
router prose, or exceed 20% influence.

Runtime research agents may treat wallet signals as token evidence only. They
cannot nominate, score, add, or drop wallets.

See ADR 002 for scoring blend, ADR 020 for runner discovery / convergence,
ADR 031 for settle/scan lock model + paper ledger finalisation, and ADR 032
for copy-trade settlement.

## Implementation map

| Concern | Path |
|---|---|
| Scoring maths | `src/wallets/scoring.ts` |
| Lifecycle transitions | `src/wallets/lifecycle.ts` |
| Discovery registration | `src/wallets/discovery.ts` |
| Runner ranking / anti-automation | `src/wallets/runner-discovery.ts` |
| Convergence deriver | `src/wallets/convergence.ts` |
| Fomo quarantine | `src/wallets/fomo-reconcile.ts` |
| Outcomes / lag | `src/wallets/outcomes.ts` |
| Review / promote-drop | `src/wallets/review.ts` |
| Exclusions | `src/wallets/exclusions.ts` |
| Operator seed | `src/wallets/seed.ts`, `src/orchestrator/wallet-seed.ts` |
| Operator candidate merge | `src/wallets/discovery.ts`, `src/orchestrator/wallet-add-candidates.ts` |
| Solana provider | `src/collectors/wallets/helius-provider.ts` |
| EVM / Robinhood provider | `src/collectors/wallets/evm-provider.ts` |
| Host jobs | `src/orchestrator/wallet-*.ts` |
