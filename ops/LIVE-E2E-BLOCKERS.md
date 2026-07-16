# Live E2E blockers (2026-07-16)

Live acceptance is **blocked** until the operator supplies credentials and
destinations. Offline gates (`pnpm test:all`) pass.

## Missing at preflight

- `CURSOR_API_KEY`
- `TRENCHCOAT_ROUTER_URL` / `TRENCHCOAT_ROUTER_TOKEN` / `TRENCHCOAT_ROUTER_HMAC_KEY`
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_OPERATOR_ID`
- `HELIUS_API_KEY` / `INFURA_API_KEY` / `NEYNAR_API_KEY` / `GOPLUS_APP_KEY` / `COINGECKO_DEMO_KEY`
- `~/.trenchcoat/config.json` (run `pnpm dev:cli init`)

## Present

- Node 23.7.0 (≥22.13)
- pnpm
- Docker (agent-runner image builds)

## To unblock

1. Copy `.env.example` → `.env` and fill secrets (never commit).
2. `pnpm prepare:agent && pnpm dev:cli init`
3. Record permission refs under `ops/permissions/`
4. `TRENCHCOAT_LIVE_E2E=1 pnpm test:e2e:live`
5. Run serialized canaries in `ops/runbook.md`
