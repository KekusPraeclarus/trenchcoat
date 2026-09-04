# FAFO Fomo web probe report

**Probe run:** operator-override-2026-09-04-alerts-smoke  
**Evaluated:** 2026-09-04  
**Source:** authenticated Playwright against fomo.family (live SPA)  
**Verification status:** live smoke pass for trending, feed `/feed/token`, and
alerts `/feed/tradingActivity`. Operator override gates installed. Not a
multi-day FAFO window.

## Summary

Integration is a read-only Playwright collector with host-only burner profile
under `~/.trenchcoat/fomo-profile/`.

Live SPA facts (2026-07-19):

- App boots at `/tokens/{chain}/{mint}` (not `/leaderboard` or `/feed`)
- Data is `prod-api.fomo.family` JSON (`/v2/leaderboard/{24h|7d|30d}`,
  `/feed/tradingActivity`, `/proxy/mostHeld`, `/proxy/trendingTokens`)
- Read POSTs for `/v2/users` (session bootstrap) and `/proxy/*` list queries
  are allowlisted; trades/transfers/edits stay blocked
- Headless Chromium needs automation-hardening flags or CF may stall API calls

## Gate seeds

- Fail-closed template: [gates.seed.json](gates.seed.json)
- Operator override (alerts): [gates.operator-override-2026-09-04.json](gates.operator-override-2026-09-04.json)

```bash
pnpm fomo:install-gates ops/fafo-fomo/gates.operator-override-2026-09-04.json
```

## Probe CLI (scaffold)

`pnpm probe:fomo` currently supports `discover | status | sanitize` only.
There is **no** `evaluate` or `sample` command yet — do not pipe those names.

```bash
pnpm probe:fomo discover --run-id probe-YYYY-MM-DD
pnpm probe:fomo status --run-id probe-YYYY-MM-DD
pnpm probe:fomo sanitize --run-id probe-YYYY-MM-DD
pnpm tsx scripts/smoke-fomo-live.ts
```

Live smoke is the short path to confirm session + parsers. Full FAFO
sample/evaluate remains follow-up work.
