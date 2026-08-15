# Pump.fun FAFO report

Live `pnpm probe:pump discover` on 2026-08-13 with the burner session.

## Status

- Session import works. Privy `/api/v1/sessions` returns 200.
- Smoke was empty before read POSTs were allowlisted.
- Request policy now allows these read POSTs on `frontend-api-v3.pump.fun`:
  `/profiles/verified`, `/users/batch`, `/coins-v2/mints`
- Cloudflare `/cdn-cgi/challenge-platform/` POST is allowed on pump.fun and
  Privy. Exact oneshot URLs change every run. Do not pin them.
- Live smoke maps FYP from `/`. Top, News, and Following are homepage
  feed tabs. Do not use `/board` or `/news` for those tabs. The PnL
  leaderboard JSON is `/pnl-leaderboard` on `/`.

## Next

Shadow rollout steps: [SHADOW-CANARY.md](SHADOW-CANARY.md).

1. Run FAFO discover on VPS and replace `gates.shadow-live.json` when sample size is enough
2. Complete 14 UTC-day shadow window per SHADOW-CANARY § Phase 2
3. Flip `pump.shadow_mode` to `false` for canary
