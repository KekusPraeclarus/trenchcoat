---
title: "031 — Wallet settle/scan brief locks and paper ledger finalisation"
status: accepted
date: 2026-07-23
---

# ADR 031: Wallet settle/scan brief locks and paper ledger finalisation

## Context

Live production (2026-07-23) showed wallet **collection** healthy (21 Solana
candidates, continuous `wallet-buy-*.json` archives) while **promotion and
paper P&L** stayed dead:

1. `wallet-scan-solana` held `agent/.lock` for the entire run — Cursor
   evidence session plus serial Helius I/O for every candidate. With 21
   wallets that often meant multi-minute (or longer) holds. Six-hour
   `outcomes-settle` and daily `wallet-review` then exited 3 after
   `run-with-lock-retry` (same starvation ADR 027 fixed for remediations).
2. Without settled 72h wallet-buy fields, `wallet-review` cannot clear
   promotion thresholds → `tracking=0` forever.
3. Track proposals opened `entry-pending` ledger rows, but `finalizeEntry`
   was test-only. Four live positions (CRED / ANSEM×2 / TripleT) never got
   an entry price. Docs claimed audit/`outcomes-settle` marked the ledger;
   code did not. Drop only matched `open` positions, so unfilled tracks
   were dead letters.

ADR 027 already rejected blanket host-only lock exemption. Wallet settle
and scan needed the **same brief-RMW pattern**, plus the missing host
ledger path.

## Decision

1. **Extend `AGENT_LOCK_EXEMPT_JOBS`** to `outcomes-settle`,
   `wallet-scan-solana`, `wallet-scan-evm`, and `wallet-review` (still not
   every host-only job).
2. **Provider I/O and archive settlement run unlocked.** Agent-state RMW
   (`wallets.json` cursors / lifecycle, `ledger.json` entry finalisation)
   uses brief `withAgentWorkspaceLock` only.
3. **`wallet-scan-*` are host-only** (no Cursor session). Cap wallets per
   tick (`wallets.max_wallets_per_scan`, default 5) with oldest-cursor
   round-robin so backfill cannot monopolise wall clock.
4. **Host `settle-ledger`** (composed into `outcomes-settle`): for each
   `entry-pending`, load `decisionTs` from the archived decision bundle
   (not `openedAt`), price via `createLiveIdentityBarProvider`,
   `firstEligibleObservation` → `finalizeEntry`. Model never writes the
   ledger (INV-S10).
5. **Drop on `entry-pending`** cancels the position (`status: censored` +
   `closedAt`). Drop on `open` still marks `exit-pending` (exit-bar
   finalisation remains a follow-up).

## Consequences

- Settle/review can run while scans fetch Helius/Infura; INV-S15 still
  serialises agent-state writers via brief locks.
- First post-decision paper entries can leave `entry-pending` without
  waiting for weekly audit.
- A catch-up `outcomes-settle` against a large `wallet-buy-*` backlog can
  still take a long wall-clock time (live Dex/Gecko pricing). After this
  ADR it must **not** hold `agent/.lock` for that duration — killing an
  old full-lock settle mid-flight is correct ops when it starves scans.
- Single-instance control for that long settle uses a **job mutex**
  (`~/.trenchcoat/locks/outcomes-settle.lock`), not `agent/.lock`. Orphan
  abandon must not apply the 30m no-`agent/.lock` rule to
  `outcomes-settle` journals (24h hard age only).
- Deploy required before live timers benefit; local code alone does not
  change VPS runtime.

## Alternatives considered

- Longer lock-retry only — still loses to multi-minute agent+RPC scans.
- Full fetch/commit split without job-level exemption — `runJob` would
  still hold the lock around the whole host phase.
- Finalising ledger entries at track time in `proposals.ts` — post-decision
  bar may not exist yet (why `entry-pending` exists).
- Manual `ledger.json` price edits — forbidden under INV-S10; must carry
  deterministic `entryObservationHash`.

## Follow-ups

- Exit-pending → closed at first post-drop bar (needs drop cutoff on the
  position).
- Audit scorecard: real `paperPnl*` from ledger + `persistScorecardToState`.
- After deploy: `tc run outcomes-settle` then `tc run wallet-review`; expect
  progressive 72h+6h maturity, not instant promotions.
