---
description: Smart-wallet discovery, deterministic scoring, bounded LLM vote, promotion/drop hysteresis, and mandatory lifecycle router events.
scope: project
status: active
last_verified: 2026-07-19
read_when:
  - Editing wallet collectors, scoring, lifecycle transitions, or wallet router events
---

# Smart wallets

Solana truth is Helius finalized standard RPC (signatures + transaction/balance
deltas). EVM truth is Infura HTTP on Ethereum and Base with finalized-block
cursors and `removed` reorg handling. Robinhood Chain uses the throttled
official public RPC (`https://rpc.mainnet.chain.robinhood.com`) and fail-closes
on HTTP 429/5xx. BSC remains wallet-tracking unsupported.

No signing libraries. No transaction submission. Read-only codecs only (INV-A1).

## Lifecycle

1. **Operator seed (optional)** — `tc wallets seed <file>` writes
   `tracking-probation` with `reasonCode: operator-seed`, takes the workspace
   writer lock, and stages one `wallet.lifecycle` router event per transition
   (unless canary blocks external effects). Refuses non-empty `wallets.json`.
   Autonomous discovery can populate an empty file. Manual Fomo wallet
   extraction can feed this path when the web scrape cannot expose exact addresses
   (see [ops/fafo-fomo/REPORT.md](../../ops/fafo-fomo/REPORT.md)).
2. **`wallet-discovery`** — host walks watchlist token identities on
   wallet-supported chains, extracts early buyers (Helius mint history /
   EVM Transfer recipients), stages `candidate` wallets, checkpoints
   resumable cursors in `state/wallets.json`. A sandboxed evidence-only agent
   may summarize a frozen wallet snapshot, but cannot affect this host work.
   Empty/skip reasons:
   `no-active-watchlist-subjects`, `no-wallet-supported-subjects`, `dry-collect`.
2b. **`fomo-trader-sync` (optional)** — host-only Fomo leaderboard sync may
   register additional `candidate` wallets with `discoveredFrom: "fomo"`
   when `fomo.enabled` + gates pass and `shadow_mode=false`. No lifecycle events
   at nomination; existing scans/review remain authoritative (INV-S19).
3. **`wallet-scan-solana` / `wallet-scan-evm`** — host performs incremental finalized action
   scans for candidates/tracking wallets; archives buy outcomes under
   `archive/outcomes/wallet-buy-*.json`. The evidence-only agent may inspect
   frozen state and recent outcomes. Empty/skip reasons:
   `wallet-state-empty`, `no-eligible-wallet-status`, `no-wallets-for-family`,
   `dry-collect`.
4. **Hard exclusions** — absolute and non-overridable by the LLM vote
   (`src/wallets/exclusions.ts`): contracts, programs, routers/pools/bridges/
   CEX/team/deployer, wash/self-transfer, security-failed tokens, failed txs,
   unfinalized or unpriceable actions. Unknown entity kinds fail closed as
   `contract`.
5. **`wallet-review` (host-only)** — lagged settled outcomes → deterministic
   score + bounded voter (neutral 50 on malformed) → promote/drop/re-add with
   hysteresis; caps `max_transitions_per_review`; stages one
   `wallet.lifecycle` router event per applied transition unless canary
   `blockExternalEffects` is set.
6. Reviews apply at most `max_transitions_per_review` per run; excess stays queued.

## Jobs / cadence (config)

| Job | Default cadence |
|---|---|
| `wallet-discovery` | `wallets.discovery_interval_hours` (6h) |
| `wallet-scan-solana` | `wallets.solana_scan_minutes` (5m) |
| `wallet-scan-evm` | `wallets.evm_scan_minutes` (15m) |
| `wallet-review` | after scans / daily |

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
router prose, or exceed 20% influence.

Runtime research agents may treat wallet signals as token evidence only. They
cannot nominate, score, add, or drop wallets.

`wallet-discovery` and `wallet-scan-*` launch `wallet-evidence` only when
prerequisites exist. It reads `wallet-evidence-*` inbox snapshots and may write
one bounded `wallet-evidence.md` report with findings and optional token
research suggestions. The host archives that report as non-authoritative
evidence and ignores decision proposals or lifecycle-shaped output from these
jobs. Empty discovery requires a tracking/watching watchlist entry. Empty scans
require an eligible seeded or discovered wallet, so cold starts use
`tc wallets seed <file>`.

See ADR 002 for the scoring decision. Review archives per-vote evidence:
`evidenceCardHash`, `voterPromptHash`, bounded raw output, parsed score, and
weighted contribution (`src/orchestrator/wallet-review.ts`).

## Implementation map

| Concern | Path |
|---|---|
| Scoring maths | `src/wallets/scoring.ts` |
| Lifecycle transitions | `src/wallets/lifecycle.ts` |
| Discovery registration | `src/wallets/discovery.ts` |
| Outcomes / lag | `src/wallets/outcomes.ts` |
| Review / promote-drop | `src/wallets/review.ts` |
| Exclusions | `src/wallets/exclusions.ts` |
| Operator seed | `src/wallets/seed.ts`, `src/orchestrator/wallet-seed.ts` |
| Solana provider | `src/collectors/wallets/helius-provider.ts` |
| EVM / Robinhood provider | `src/collectors/wallets/evm-provider.ts` |
| Host jobs | `src/orchestrator/wallet-*.ts` |
