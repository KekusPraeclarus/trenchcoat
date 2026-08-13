---
description: pump.fun authenticated SPA scrape for FYP/Top/News/Following feed curation, leaderboard, and call-chart evidence. Burner-only. No wallets.
scope: knowledge
status: active
last_verified: 2026-08-13
source: https://pump.fun
read_when:
  - Implementing or debugging the pump.fun collector, pump-scan, or pump engagement.
do_not_read_when:
  - The task only needs X FYP or Fomo.family behaviour.
---

# pump.fun (web feed)

[pump.fun](https://pump.fun) is scraped via Playwright with a host-only burner
session (`~/.trenchcoat/pump-profile/`). There is no API key. Read-only HTTP
plus allowlisted SPA read POSTs. Trades, swaps, DMs, and coin creates stay
blocked. Like/follow/unfollow run in a separate host mutation session after
the agent proposes them.

Do not reuse the X engagement lane. INV-S22 binds likes to `x-fyp-eligible`
only. Pump uses `pump-fyp-eligible` and `state/pump-engagement.json`.

## Binding rules

- Host-only burner profile (INV-I3). Never under `agent/`, never in fixtures
- Navigation budget + request policy gate every request (INV-R1)
- Snapshots are `trust: untrusted-external` (INV-P1)
- Mutations and research enqueue only when FAFO gates pass and
  `shadow_mode=false`. Pump never writes `wallets.json`
- Health reports Pump as a parallel-only section

## Jobs

- `pump-scan` — doomscroll FYP, Top, News. Scrape Following after 10 follows.
  Scrape Leaderboard (handles only). Visit a bounded set of caller profiles
  for Pump UI call charts. Agent proposes like/follow. Host applies. Host
  archives pump-call events and may enqueue research.

## Probe

```bash
pnpm dev:cli auth pump
TRENCHCOAT_LIVE_PUMP=1 pnpm tsx scripts/smoke-pump-live.ts
TRENCHCOAT_LIVE_PUMP=1 pnpm probe:pump discover --run-id probe-YYYY-MM-DD
pnpm probe:pump status --run-id probe-YYYY-MM-DD
pnpm probe:pump sanitize --run-id probe-YYYY-MM-DD
pnpm tsx scripts/smoke-pump-live.ts
pnpm pump:install-gates ops/fafo-pump/gates.seed.json
```

Live hosts and POST paths land in [ops/fafo-pump/REPORT.md](../../ops/fafo-pump/REPORT.md)
after discover. Do not treat GitHub API dumps as truth.

## Session import

Use the zero-funds burner only. Do not export a funded wallet session.

1. Log in to pump.fun in your normal browser as the burner.
2. Copy the Cookie request header from DevTools. No extension is required.
   On `https://pump.fun`, open Network, reload, click the document request,
   then copy Request Headers → Cookie. Save that one line to
   `~/.trenchcoat/pump-profile/import-cookie-header.txt`. Do not paste it into
   chat. Cookie-Editor JSON still works if you prefer `--import-cookies`.
3. On pump.fun, run this in DevTools and save the download next to the cookie
   file as `import-local-storage.json`:

```javascript
(() => {
  const data = JSON.stringify(Object.fromEntries(Object.entries(localStorage)))
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }))
  a.download = "import-local-storage.json"
  a.click()
})()
```

4. Import on the machine. Do not send the files anywhere:

```bash
pnpm dev:cli auth pump --import-cookie-header ~/.trenchcoat/pump-profile/import-cookie-header.txt \
  --import-local-storage ~/.trenchcoat/pump-profile/import-local-storage.json
```

The host writes `~/.trenchcoat/pump-profile/storage-state.json` mode 600. It
prints cookie counts only. It never prints values.

## Pitfalls

- The homepage sets anonymous Privy cookies before login. `auth pump` waits
  for Enter in the terminal. It does not close on cookie presence. Headless
  scrapes reuse `~/.trenchcoat/pump-profile/`. They do not open a login window
- Playwright Chromium has no wallet extension. Wallet login often fails there.
  Import a burner session from your normal browser. Never paste cookies into
  chat, git, or `agent/`
- Call cards use `coinMint` and `userId`. Join `userId` to `/users/batch`
  `username`. Do not use the wallet as author. PnL board JSON uses `entries`
- For you, Top, News, and Following are homepage feed tabs. Do not scrape
  `/board` or `/news` for those tabs. The PnL leaderboard is also on `/`
- Pump user ids are not trading wallets. Do not nominate them into
  `wallets.json`
- Inbox item text must not use the word call (X `extractCallEvents` would
  treat a mint plus that word as a source-call)
- Following items are evidence. They are not like/follow targets
- `chart-sweep` stays watchlist-only. Pump charts are captured on pump-scan
  and on pump-origin research

## Hallucination warnings

- There is no official public Pump API key
- `app.pump.fun` is a download landing page, not the scrape target
- Do not MITM the iOS/Android app

## Sources

- https://pump.fun, checked 2026-08-13
- Session/mutation split: [x-playwright.md](x-playwright.md)
- SPA policy pattern: [fomo-family.md](fomo-family.md)
- Binding decision: [ADR 047](../adr/047-pump-feed-scan.md)
