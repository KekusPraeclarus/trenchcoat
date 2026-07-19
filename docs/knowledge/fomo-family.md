---
description: Fomo.family authenticated SPA scrape used as the social-graph bridge for trader nomination and signals. Burner-only; nomination/evidence only.
scope: knowledge
status: active
last_verified: 2026-07-19
source: https://fomo.family
---

# Fomo.family (web bridge)

[fomo.family](https://fomo.family) is scraped via Playwright with a host-only
burner session (`~/.trenchcoat/fomo-profile/`). There is no API key. Read-only
HTTP methods plus an allowlisted set of SPA read POSTs (`/v2/users` bootstrap,
`/proxy/*` lists); trades/transfers/profile edits stay blocked.

## Binding rules

- Host-only burner profile (INV-I3). Never under `agent/`, never in fixtures
- Navigation budget + request policy gate every request (INV-R1)
- Snapshots are `trust: untrusted-external` (INV-P1)
- Wallet / research / X-nomination mutations only when FAFO gates pass and
  `shadow_mode=false`. Health reports FOMO as a parallel-only section — it
  never clears FC corroboration or legacy research/wallet warnings

## Jobs

- `fomo-trader-sync` — leaderboard → wallet candidates + X nominations
- `fomo-signal-scan` — feed / alerts / derived convergence & pressure
- `fomo-x-source-review` — classify nominated X accounts; host merge extracts
  historical calls for shillers (`awaiting-review-epoch`) and registers narrative
  probation for narrative/both
- `fomo-narrative-source-scan` — live (<=6h) posts from probation narrative X
  sources (never reuses historical review posts)
- `narrative-source-review` — promote/demote narrative sources; capped follow
  via existing X engagement executor
- Research dossiers may attach live `fomo-context` from the observation cache
  when `fomo.enabled`
- `narrative-scan` copies sealed fomo narrative posts into
  `narrative-social-fomo-x` (excludes `purpose=historical-source-evaluation`)

## Probe

```bash
pnpm probe:fomo discover --run-id probe-YYYY-MM-DD
pnpm probe:fomo status --run-id probe-YYYY-MM-DD
pnpm probe:fomo sanitize --run-id probe-YYYY-MM-DD
pnpm tsx scripts/smoke-fomo-live.ts
pnpm fomo:install-gates ops/fafo-fomo/gates.operator-override-2026-07-19.json
```

`probe:fomo` has no `evaluate` command yet. Live smoke confirms parsers against
the authenticated SPA; install an operator override or FAFO gates JSON after.

Details: [ops/fafo-fomo/REPORT.md](../../ops/fafo-fomo/REPORT.md).
