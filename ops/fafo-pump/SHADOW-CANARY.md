# Pump.fun shadow → canary playbook

Implements the pump.fun web feed scan after gates allow collection.
**Current status (2026-08-13):** fail-closed seed. Live discover is pending.

## Prerequisites

1. `pnpm dev:cli auth pump` then `TRENCHCOAT_LIVE_PUMP=1 pnpm pump:smoke`
   returns non-zero counts
2. Persist gates: `pnpm pump:install-gates path/to-gates.json`
   - fail-closed seed: `ops/fafo-pump/gates.seed.json`
3. Live config schema current (`tc config validate`)

## Shadow (exactly 14 UTC days)

```json
"pump": {
  "enabled": true,
  "shadow_mode": true,
  "engagement": { "enabled": true },
  "leaderboard": { "enabled": true }
}
```

Jobs write snapshots and skip receipts. `wallets.json`, research queue,
watchlist, and `x-engagement.json` stay byte-identical. Pump still archives
pump-call events. Mutations and research enqueue stay off.

**Shadow graduation:** provider success ≥95%. No secret or invariant
breaches. Operator reviews enqueue rates.

## Canary

Flip `shadow_mode: false`. Keep daily enqueue cap at 3. Keep likes at 2 per
10 minutes and follows at 3 per run.

## Ongoing

- Monthly live smoke: `TRENCHCOAT_LIVE_PUMP=1 pnpm pump:smoke`
- Re-auth burner if session_expired / challenged rates rise
- Replace seed gates with real FAFO sample when discover completes
