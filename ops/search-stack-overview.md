---
description: Short overview of trenchcoat social scrape, web search, and free vs paid data sources. Safe to paste for peer operators.
scope: ops
status: active
last_verified: 2026-08-12
---

# Search / crawl / scan stack (for Aussie)

Short answer: we run our own collectors outside the agent
sandbox. Most social and market ingest stays on free tiers or zero-key public
APIs. Paid keys stay optional and host-only.

## How it fits together

1. **Collectors** (Node/TS, host process) fetch X, Telegram, market APIs, and
   optional web search. They write timestamped snapshots into the agent inbox.
2. **Agent** (Cursor CLI, sandboxed) reads those files only. It has **no
   network**. It does not pick URLs or hold API keys.
3. A shared **rate-limit gate** caps every upstream call so free tiers stay
   inside published limits.

So "search/crawl/scan" is host code plus cron/KeepAlive jobs, not the model
browsing the open web.

## Social

| Source | Method | Cost posture |
|---|---|---|
| **X / Twitter** | Playwright on a burner account. Streaming `x-scan` round-robins FYP + operator lists. Research runs bounded token search (`$SYMBOL`, address, chain queries). | No paid X API. Account + scrape risk only. |
| **Telegram alpha** | Prefer public `t.me/s/<channel>` HTML preview (zero credential). GramJS user session only when a channel has no preview. | Free. |
| **Farcaster** | Neynar API when opted in (`farcaster.enabled`). Off by default in our deploy. | Keyed; free/paid Neynar tier as you choose. |
| **Fomo.family** | Authenticated Playwright SPA scrape for trader/feed signals and X-source nomination. | Free scrape; burner profile. |

X posts and channel text land as `untrusted-external` evidence with provenance
(`twitter:@handle`, `telegram:<channel>`, etc.). The agent never treats that
text as instructions.

## Web search

- Provider: **Tavily** (`api.tavily.com/search`), host-mediated.
- Flow: agent writes validated queries → host POSTs → hits return as inbox
  snapshots. Model never chooses fetch URLs.
- Cost: **free tier** (about 1,000 credits/month; `basic` search = 1 credit).
  We cap `research.web_search.max_queries_per_run` (default ≤ 3). Without
  `TAVILY_API_KEY`, research skips web search quietly.
- We dropped Brave Search earlier; Tavily is the sole web provider.

## Market / discovery (feeds the same research path)

Mostly keyless or free demo:

- **DexScreener** — pairs, prices, boosts/profiles (no key)
- **GeckoTerminal** — OHLCV / new pools (no key)
- **CoinGecko Demo** — trending coins + categories (demo key)
- **GoPlus** + **RugCheck** — token security gate (free / keyless basic)
- **Fear & Greed** — keyless macro context

Optional paid or keyed fallbacks we use when we need them:

- **Helius** / **Infura** — wallet finalized feeds
- **SolanaTracker** / **Birdeye** — OHLCV fallback when Gecko fails
- **Neynar** — Farcaster (dormant unless enabled)
- **Tavily** — research web search (free tier is enough for our caps)

We rejected CryptoPanic and LunarCrush when free tiers went away.

## Jobs that do the scanning

Examples (not exhaustive): streaming `x-scan` / legacy `list-scan`,
`narrative-scan`, `watchlist-scan`, research queue / Discord research,
`telegram-alpha` digestion, Fomo signal / source review jobs.

## Tl;Dr

> We self-host collectors: Playwright burner for X (no paid API), Telegram via
> public `t.me/s/` previews, optional Neynar for Farcaster (off by default),
> and Tavily free-tier for host-gated web search. Market side is mostly
> DexScreener + GeckoTerminal + CoinGecko demo. Agent stays offline; only the
> host fetches. Still mostly free — optional keys for wallets/OHLCV/FC/web when
> we need them.
