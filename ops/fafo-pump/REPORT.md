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

1. `TRENCHCOAT_LIVE_PUMP=1 pnpm tsx scripts/smoke-pump-live.ts`
2. If feed counts are still 0, inspect mapper fields against sanitized
   `coins-v2/mints` samples. Do not paste session files.
3. `pnpm probe:pump sanitize --run-id probe-2026-08-13`
4. Replace `ops/fafo-pump/gates.seed.json` after sample size is enough.
