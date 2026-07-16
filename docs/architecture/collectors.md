---
description: Collectors module - Playwright Twitter scraping, Telegram alpha-channel listener, market-data clients (GeckoTerminal, DexScreener, CoinGecko trending, Fear & Greed), indicators incl. RSI, rate-limit gate, snapshot and provenance format.
scope: module
status: draft
last_verified: 2026-07-16
read_when:
  - Editing src/collectors/ or src/lib/.
  - Adding a data source or changing the snapshot, provenance, or alpha-queue format.
---

# Collectors

## Purpose

Deterministic code that turns the outside world into timestamped files. All network
access in the system happens here. Collectors never interpret — no LLM calls, no
decisions — so a run is reproducible from its inputs.

## Sources

### Twitter (Playwright)

- Dedicated **burner account**; credentials and the persistent auth profile live
  under `~/.trenchcoat/browser-profile/` (outside the repo, never inside `agent/`)
- Headless by default; when login or a challenge is detected, fail the run with a
  clear "needs headful re-auth" error — the operator runs `trenchcoat auth twitter`
  to fix it interactively. Never attempt automated challenge solving.
- Scrape targets: token search results, specific profiles, the curated trends list
- Human-ish pacing (randomised delays, capped pages per run) to respect the platform
  and keep the account alive. Scrape read-only; never post, like, or follow.

### Telegram alpha channels (preview poller + GramJS listener)

Bot API bots cannot read channels without being added by an admin, so no bot path
exists. Two ingestion modes, chosen per channel at config time:

- **Preview poller (preferred)** — public channels expose a zero-credential HTML
  preview at `t.me/s/<channel>` (paginated via `?before=<msg-id>`). Poll it on the
  collector cycle; no session, no flood-wait, no account risk. Channels with
  previews disabled are detected (empty message blocks) and flagged for the
  fallback.
- **GramJS (MTProto) listener (fallback)** — a long-lived user-session process for
  channels without previews, running under launchd with keepalive. Session
  credentials live under `~/.trenchcoat/telegram-session/`, same rules as the
  browser profile. Respect `FLOOD_WAIT` absolutely; passive only (no sends, no
  joins beyond the configured list).

Both modes append every new message to `agent/alpha-queue/<channel>/<msg-id>.json`
with full provenance and deduplicate on message id; digestion and purge are the
orchestrator's job (see orchestrator.md, INV-Q1).

### Token security (research gate)

- **GoPlus** — `GET api.gopluslabs.io/api/v1/token_security/{chain_id}` (EVM
  chains, free tier, keyed via console): honeypot, mint authority,
  blacklist/whitelist, buy/sell tax, LP lock flags
- **RugCheck** — `GET api.rugcheck.xyz/v1/tokens/{mint}/report` (Solana, keyless
  basic lookups): mint/freeze authority, LP lock
- Run by the `research` collector set before the agent session; a hard-fail flag
  short-circuits the verdict to `ignore` without an LLM call (cheap and safe)

### New-pool feed (discovery ahead of social)

GeckoTerminal new-pools / DexScreener new pairs, fetched on the list-scan cycle.
This stream is overwhelmingly garbage, so it is filtered hard before the agent
ever sees it: security gate first (GoPlus/RugCheck), then a liquidity floor and
minimum-age/txn sanity checks. Survivors enter the snapshot as candidates with
`provenance: "feed:new-pools"` — attention-independent discovery, often earlier
than any tweet.

### Attention–price divergence

Deterministic metric written into watchlist-scan and research snapshots: mention
velocity (tweet + alpha-queue counts per window, weighted by source score) against
the price/volume move over the same window. Divergence direction is the signal:
attention up + price flat = early; attention spiking after a large move = late.

### Market data

- **GeckoTerminal** — OHLCV candles, pool stats. 30 calls/min, no key. The only
  free OHLCV source in the stack; guard it jealously.
- **DexScreener** — pair discovery, live price/liquidity/txn counts, token
  profiles, **boosted/trending tokens** (paid-attention signal). 300 req/min
  (60 req/min on profile/boost endpoints), no key, no OHLCV.
- **CoinGecko Demo** — `/search/trending`: top coins *and categories* by search
  attention; categories are a direct narrative signal. 10k calls/mo budget —
  a few calls per list-scan/narrative-scan cycle, nowhere near the cap.
- **Alternative.me Fear & Greed** — keyless; one call per review cycle for macro
  mood context.

### Indicators

Pure functions over OHLCV: **RSI (14, per timeframe)**, volume z-score, range
breakout, EMA structure, liquidity delta. Computed here (deterministic, testable)
and written alongside the raw candles so the agent interprets numbers rather than
recomputing them. The audit job reuses the same functions to score past calls
(e.g. RSI at decision time vs the subsequent move), so keep them pure and
timestamp-parameterised — never "now"-dependent.

## Rate-limit gate

One shared token-bucket per upstream host in `src/lib/`, consulted by every client
(including the audit job's outcome fetches and chat-triggered research). Budgets set
below published limits (GeckoTerminal 25/min, DexScreener 200/min, CoinGecko
spread across the month). On 429: back off per `Retry-After` if present, exponential
otherwise; never tighten the loop.

## Snapshot and provenance format

`agent/inbox/<run-id>/<source>.<name>.json` (or `.md` for prose-like content):

```json
{
  "source": "twitter.list-scan",
  "fetched_at": "2026-07-16T07:00:00Z",
  "trust": "untrusted-external",
  "items": [
    { "provenance": "twitter:@handle", "text": "…", "url": "…", "ts": "…" }
  ]
}
```

- `trust: "untrusted-external"` is mandatory on anything containing third-party text
- **`provenance` is mandatory per item** — `twitter:@handle`,
  `telegram:<channel>`, `coingecko:trending`, etc. It must match a key in
  `agent/state/sources.json` (or be auto-registered there at neutral score) so the
  agent can weight evidence and the audit can attribute outcomes (INV-S6)
- Raw text is carried verbatim inside `items` — collectors never "clean" it in ways
  that could hide manipulation, and never promote it into keys or filenames

Alpha-queue entries use the same envelope, one file per message, so digestion can
be tracked and purged per message id.

## Source files to inspect before editing (once implemented)

- `src/lib/rate-gate.ts` — the shared token bucket
- `src/lib/snapshot.ts` — the only writer into `agent/inbox/` and
  `agent/alpha-queue/`; enforces envelope + provenance
- `src/collectors/twitter/session.ts` — auth profile handling
- `src/collectors/telegram/listener.ts` — gramjs subscription, flood-wait handling

## Gotchas and security-sensitive boundaries

- **DexScreener has no OHLCV** — do not add a candle fetcher against it; use
  GeckoTerminal
- Scraped text (tweets *and* alpha-channel messages — the latter are shill-heavy by
  nature) is attacker-controlled: it must reach the agent only inside the snapshot
  envelope (INV-P1), and must never be interpolated into shell commands, file
  paths, or the job prompt
- The browser profile and telegram session contain live credentials — they stay
  outside the repo and outside every snapshot; grep for their paths in review when
  touching either collector
- Snapshot writer must refuse paths that escape `agent/inbox/` /
  `agent/alpha-queue/` (no `..`, absolute paths, or symlinks) — message ids and
  channel names are attacker-influenced, sanitise them (INV-I4)
- CoinGecko's 10k/mo budget is monthly, not per-minute — the gate must track a
  monthly counter for it, not just a bucket
