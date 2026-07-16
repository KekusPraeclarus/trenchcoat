---
description: Collectors module - Playwright Twitter scraping, GeckoTerminal/DexScreener clients, indicator maths, rate-limit gate, snapshot format.
scope: module
status: draft
last_verified: 2026-07-16
read_when:
  - Editing src/collectors/ or src/lib/.
  - Adding a data source or changing the snapshot format.
---

# Collectors

## Purpose

Deterministic code that turns the outside world into timestamped files. All network
access in the system happens here. Collectors never interpret — no LLM calls, no
decisions — so a run is reproducible from its inbox.

## Sources

### Twitter (Playwright)

- Chromium with a persistent auth profile under `~/.trench-bot/browser-profile/`
  (outside the repo, never inside `agent/`)
- Headless by default; when login or a challenge is detected, fail the run with a
  clear "needs headful re-auth" error — the operator runs `trench auth twitter` to
  fix it interactively. Never attempt automated challenge solving.
- Scrape targets: token search results, specific profiles, the curated trends list
- Human-ish pacing (randomised delays, capped pages per run) to respect the platform
  and keep the account alive. Scrape read-only; never post, like, or follow.

### Market data

- **GeckoTerminal** — OHLCV candles, pool stats. 30 calls/min, no key. The only
  free OHLCV source in the stack; guard it jealously.
- **DexScreener** — pair discovery, live price/liquidity/txn counts, token profiles.
  300 req/min (60 req/min on profile/boost endpoints), no key, no OHLCV.
- **CoinGecko Demo** (optional, keyed) — metadata backfill. Not in v1.

### Indicators

Pure functions over OHLCV: volume z-score, range breakout, EMA structure, liquidity
delta. Computed here (deterministic, testable) and written alongside the raw candles
so the agent interprets numbers rather than recomputing them.

## Rate-limit gate

One shared token-bucket per upstream host in `src/lib/`, consulted by every client.
Budgets set below published limits (GeckoTerminal 25/min, DexScreener 200/min) to
absorb clock skew and retries. On 429: back off per `Retry-After` if present,
exponential otherwise; never tighten the loop.

## Snapshot format

`agent/inbox/<run-id>/<source>.<name>.json` (or `.md` for prose-like content):

```json
{
  "source": "twitter.list-scan",
  "fetched_at": "2026-07-16T07:00:00Z",
  "trust": "untrusted-external",
  "items": [ { "author": "…", "text": "…", "url": "…", "ts": "…" } ]
}
```

- `trust: "untrusted-external"` is mandatory on anything containing third-party text
- Raw text is carried verbatim inside `items` — collectors never "clean" it in ways
  that could hide manipulation, and never promote it into keys or filenames

## Source files to inspect before editing (once implemented)

- `src/lib/rate-gate.ts` — the shared token bucket
- `src/lib/snapshot.ts` — the only writer into `agent/inbox/`
- `src/collectors/twitter/session.ts` — auth profile handling

## Gotchas and security-sensitive boundaries

- **DexScreener has no OHLCV** — do not add a candle fetcher against it; use
  GeckoTerminal
- Scraped text is attacker-controlled: it must reach the agent only inside the
  snapshot envelope (INV-P1), and must never be interpolated into shell commands,
  file paths, or the job prompt
- The browser profile contains live Twitter credentials — it stays outside the repo
  and outside every snapshot; grep for its path in review when touching the scraper
- Snapshot writer must refuse paths that escape `agent/inbox/` (no `..`, absolute
  paths, or symlinks)
