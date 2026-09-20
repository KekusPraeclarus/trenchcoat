# Pump.fun FAFO report

Live `pnpm probe:pump discover` on the VPS as `probe-2026-09-04`.
Earlier Mac discover on 2026-08-13 still matches the allowlist.

## Status

- Installed gates: `ops/fafo-pump/gates.evaluated-2026-09-04.json`
  (`probe-2026-09-04`). Provider, feed, and leaderboard are `pass`.
  Following stays `insufficient-sample` (0 follows in shadow).
- Shadow collect sample 2026-08-26 through 2026-09-04: 171 collects,
  171 non-zero FYP/Top/News, 170 non-zero leaderboard. Budget skips
  after the daily cap are not provider failures.
- Privy `/api/v1/sessions` returned 200 on the 2026-09-04 discover.
- Request policy still allows these read POSTs on
  `frontend-api-v3.pump.fun`: `/profiles/verified`, `/users/batch`,
  `/coins-v2/mints`. Discover confirmed the same paths. No new read
  POST was added.
- Discover still blocks `/users/register`, `swap-api.pump.fun`,
  `solana-mainnet.pump.fun`, and analytics hosts.
- Cloudflare `/cdn-cgi/challenge-platform/` POST is allowed on pump.fun
  and Privy. Exact oneshot URLs change every run. Do not pin them.
- Live smoke maps FYP from `/`. Top, News, and Following are homepage
  feed tabs. Do not use `/board` or `/news` for those tabs. The PnL
  leaderboard JSON is `/pnl-leaderboard` on `/`.
- Live smoke must set `debitAttempts: false`. A 40-nav smoke cap must
  not rewrite `archive/provider-usage/pump/<day>.json`.
- Ranked feed cursors skip a prior id. They do not abort the page.
- Live like control (2026-09-20 homepage): data-testid=callout-action-like,
  aria-label Like this callout, card href /callouts/:mint/:uuid.
  Contract path POST/DELETE `/callout/{calloutId}/like` on
  frontend-api-v3.pump.fun. Mutation mode must allow DELETE unlike.

## Next

Canary rollout steps: [SHADOW-CANARY.md](SHADOW-CANARY.md) § Phase 3.

1. Watch the first canary `pump-scan` after 00:00 UTC for engagement
   receipts and session errors. Remaining 2026-09-17 runs skip on
   `budget_exhausted`.
2. Keep likes at 2 / 10 minutes and follows at 3 per run. Keep research
   enqueue at 3 per UTC day.
3. Following tab stays skipped until `followedHandles.length` reaches 10.
