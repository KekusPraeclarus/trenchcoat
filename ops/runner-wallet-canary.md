# Runner wallet discovery — shadow → canary

Operator checklist for ADR 020. Defaults stay `enabled: false` /
`shadow_mode: true` until each gate below is green.

## Gate 1 — Offline

- [ ] `pnpm test:all` green (wallet-runner, convergence, fomo quarantine,
  crash cursors, red-team confinement)

## Gate 2 — Live shadow discovery

```json
"wallets": {
  "runner_discovery": { "enabled": true, "shadow_mode": true },
  "convergence": { "enabled": false, "shadow_mode": true }
}
```

- [ ] `tc run wallet-runner-discovery` archives qualification receipts
- [ ] `state/wallets.json` and research queue unchanged
- [ ] No `wallet.convergence` outbox events

## Gate 3 — Candidate-write canary (alerts blocked)

Flip `runner_discovery.shadow_mode: false`. Keep convergence off / blocked.

Per-chain floors before Gate 4:

| Chain | Qualified runners | Verified buyer events |
|---|---|---|
| solana | ≥20 | ≥50 |
| ethereum + base (Infura) | ≥20 | ≥50 |
| robinhood | ≥10 | ≥25 |

A failing chain stays on Gate 3; healthy chains may advance.

## Gate 4 — Convergence canary (research on, alerts blocked)

```json
"convergence": { "enabled": true, "shadow_mode": true }
```

Or enable with canary `blockExternalEffects` so research may enqueue while
router delivery stays blocked.

- [ ] Research queue receives `trigger: wallet-convergence` (cap 5/day)
- [ ] No Telegram/Discord `UNVERIFIED WALLET CONVERGENCE` delivery

## Gate 5 — Capped alerts

`convergence.shadow_mode: false` only after zero false buyer classifications
and zero duplicate alert/enqueue IDs in canary receipts for every enabled
chain.

Daily caps remain: 10 alerts, 5 research enqueues, 6h per-token cooldown.
