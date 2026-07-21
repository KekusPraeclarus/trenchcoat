# Fomo shadow → canary playbook

Implements the Fomo web integration after gates allow collection.
**Current status (2026-07-19):** operator override gates installed after live
smoke (leaderboard/feed/trending). Full multi-day FAFO still pending.

## Prerequisites

1. `pnpm dev:cli auth fomo` then `pnpm tsx scripts/smoke-fomo-live.ts` returns
   non-zero counts (not stubs)
2. Persist gates: `pnpm fomo:install-gates path/to/gates.json`
   - fail-closed seed: `ops/fafo-fomo/gates.seed.json`
   - tonight's override: `ops/fafo-fomo/gates.operator-override-2026-07-19.json`
3. Live config schema current (`tc config validate`)

## Shadow (exactly 14 UTC days)

```json
"fomo": {
  "enabled": true,
  "shadow_mode": true,
  "trader_sync": { "enabled": true },
  "signal_scan": {
    "enabled": true,
    "feed": true,
    "trending": true,
    "convergence": true
  }
}
```

Only enable capability flags whose gate is `pass`. Jobs write snapshots and
skip receipts; `wallets.json`, research queue, watchlist, X nominations,
sources, engagement, and broadcast state stay byte-identical. Keep
`x_source_review` / `narrative_source_probation` off until canary.

Daily metrics helper:

```bash
pnpm tsx scripts/fomo-shadow-metrics.ts --day $(date -u +%F)
```

**Shadow graduation:** provider success ≥95%; no secret/payment/invariant
breaches; signal enqueue rates reviewed by operator.

## Canary

Flip `shadow_mode: false` for a single capability at a time. Keep
`x_source_review` and `narrative_source_probation` off until their dedicated
FAFO notes pass.

## Ongoing

- Monthly live smoke: `pnpm tsx scripts/smoke-fomo-live.ts`
- Re-auth burner if session_expired / challenged rates rise
- Replace operator override with real FAFO sample/evaluate when implemented
