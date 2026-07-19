# Fomo shadow → canary playbook

Implements the Fomo web integration after FAFO gates pass.
**Current status (2026-07-19):** provider gate = fail (seed stub). Do not enable
scheduled mutation until live probe passes.

## Prerequisites

1. `pnpm dev:cli auth fomo` then `pnpm probe:fomo discover|sanitize` completes
2. Persist gates: `pnpm fomo:install-gates path/to/evaluated-gates.json`
   (seed template: `ops/fafo-fomo/gates.seed.json` — replace after successful probe)
3. `tc config migrate --write` so `~/.trenchcoat/config.json` is schema 9

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

Only enable capability flags whose FAFO gate is `pass`. Jobs write snapshots and
skip receipts; `wallets.json`, research queue, watchlist, X nominations,
sources, engagement, and broadcast state stay byte-identical. Keep
`x_source_review` / `narrative_source_probation` off until canary.

Daily metrics helper:

```bash
pnpm tsx scripts/fomo-shadow-metrics.ts --day $(date -u +%F)
```

**Shadow graduation:** provider success ≥95%; no secret/payment/invariant
breaches; wallet nomination and signal enqueue rates reviewed by operator.

## Canary

Flip `shadow_mode: false` for a single capability at a time. Keep
`x_source_review` and `narrative_source_probation` off until their dedicated
FAFO notes pass.

## Ongoing

- Monthly `pnpm probe:fomo discover --run-id probe-$(date -u +%F)` schema probe
- Re-auth burner if session_expired / challenged rates rise
