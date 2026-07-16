# Live E2E blockers (2026-07-16)

Live acceptance is **blocked** until the operator supplies credentials and
destinations. Offline gates (`pnpm test:all`) pass.

## Cursor agent (required for live jobs)

Use the [Cursor CLI](https://cursor.com/docs/cli/installation), not an API key:

```bash
curl https://cursor.com/install -fsS | bash
agent login
agent status   # must show Logged in as …
```

Optional: `TRENCHCOAT_CURSOR_BIN` if `agent` is not on PATH.

## Missing at preflight (non-Cursor)

- `TRENCHCOAT_ROUTER_URL` / `TRENCHCOAT_ROUTER_TOKEN` / `TRENCHCOAT_ROUTER_HMAC_KEY`
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_OPERATOR_ID`
- `HELIUS_API_KEY` / `INFURA_API_KEY` / `NEYNAR_API_KEY` / `GOPLUS_APP_KEY` / `COINGECKO_DEMO_KEY`
- `~/.trenchcoat/config.json` (run `pnpm dev:cli init`)

## Present

- Node ≥22.13
- pnpm
- Docker (agent-runner image builds)
- Cursor CLI when `agent` is installed and logged in

## To unblock

1. `agent login` (and keep session alive)
2. Copy `.env.example` → `.env` and fill non-Cursor secrets (never commit)
3. `pnpm prepare:agent && pnpm dev:cli init`
4. Record permission refs under `ops/permissions/`
5. `TRENCHCOAT_LIVE_E2E=1 pnpm test:e2e:live`
