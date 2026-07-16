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

Deterministic code that turns the outside world into timestamped files. Upstream
market/social fetches for jobs go through collectors and the shared rate gate.
Other host components (router delivery, Telegram chat bridge) also use the
network, but not for collector-shaped ingestion. Collectors never interpret —
no LLM calls, no decisions — so a run is reproducible from its inputs.

## Sources

### Twitter (Playwright)

- Dedicated **burner account**; credentials and the persistent auth profile live
  under `~/.trenchcoat/twitter-profile/` (outside the repo, never inside `agent/`)
- Headless by default; when login or a challenge is detected, fail the run with a
  clear "needs headful re-auth" error — the operator runs `trenchcoat auth twitter`
  to fix it interactively. Never attempt automated challenge solving.
- Scrape targets: token search results, FYP, exactly two immutable operator lists,
  and one bot-managed private source list
- Human-ish pacing (randomised delays, capped pages per run) to respect the platform
  and keep the account alive. Scrape read-only; never post, like, or follow.

The normal collector blocks every mutating HTTP method. A separate host-only
managed-list synchronizer is the sole exception: it may create one private list
once and add/remove members only when the target list ID exactly matches the
persisted managed-list ID. It blocks posts, likes, follows, reposts, DMs, and all
other mutations (INV-R2).

Accounts first seen on FYP or either immutable operator list enter host-owned
probation for **shill scoring**. Promotion and demotion of the managed private
list use only lagged, settled outcomes from direct bullish raw-CA call events
(INV-S21). Operator lists themselves are never mutated.

Separately, `list-scan` lets the bot choose FYP likes/follows for narrative and
sentiment feed training. Choices are applied after the session with a default
like throttle of 2 per 10 minutes (config-bounded; INV-S22 PARTIAL); posts,
replies, DMs, and retweets stay blocked (INV-R2).

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
Each append writes a same-directory temporary file, fsyncs it, then atomically
renames to the sanitised final path using create-if-absent semantics. A concurrent
listener/job can observe the old file or the complete new file, never a partial
message.

### Token security gate

- **GoPlus** — `GET api.gopluslabs.io/api/v1/token_security/{chain_id}` (EVM
  chains, free tier, keyed via console): honeypot, mint authority,
  blacklist/whitelist, buy/sell tax, LP lock flags
- **RugCheck** — `GET api.rugcheck.xyz/v1/tokens/{mint}/report` (Solana, keyless
  basic lookups): mint/freeze authority, LP lock
- Scanner selection per chain via the chain registry (chains.md); no scanner
  coverage → fail-closed, candidate untrackable
- Runs at research dequeue **and** as the new-pool stream filter; a typed
  hard-fail short-circuits to `ignore` without an LLM call and triggers the
  rug-shill dock. Exact field→flag mapping, thresholds, and the
  market-quality preflight (liquidity, txn, wash-filter floors) live in
  security-gate.md

### New-pool feed (discovery ahead of social)

GeckoTerminal new-pools / DexScreener new pairs, fetched on the list-scan cycle.
This stream is overwhelmingly garbage, so it is filtered hard before the agent
ever sees it: security gate first (GoPlus/RugCheck), then a liquidity floor and
minimum-age/txn sanity checks. Survivors enter the snapshot as candidates with
`provenance: "feed:new-pools"` — attention-independent discovery, often earlier
than any tweet. Filtered-out candidates are appended to the host-side discovery
log so the audit can price what the filters rejected (filter recall loss,
audit-metrics.md) — thresholds get tuned by evidence, not vibes.

### Mention preprocessing (dedupe + independence clusters)

Deterministic preprocessing before any mention is counted:

- **Resolution first** — mentions attach to canonical identities, either
  `resolved` or `model-confirmed` from the disambiguation dossier
  (token-resolution.md); mentions with no binding at all are excluded from
  velocity maths
- **Dedupe** — normalised-text fingerprint per item; retweets, copy-pastes,
  and identical CA+template posts within the window collapse to one event
  (`dedupe_key` on the item)
- **Independence clusters** — host-side union-find over sources: two sources
  link if they repeatedly co-post the same CA within a short Δt or share
  template fingerprints. `cluster_id` lands in `sources.json`; snapshots carry
  both `raw_mentions` and `effective_mentions` (unique clusters, per-cluster
  contribution capped) plus `cluster_count`. Corroboration means independent
  clusters — a Sybil farm is one voice

### Attention–price divergence

Deterministic metric written into watchlist-scan and research snapshots:
**effective** mention velocity (deduped, cluster-capped, weighted by
start-of-run source score) against the price/volume move over the same window.
Divergence direction is the signal: attention up + price flat = early;
attention spiking after a large move = late. Two explicit flags accompany it:
`late_attention` (mention z-score spikes after an already-large move) and
`exit_liquidity_risk` (attention spike + declining liquidity + overbought RSI)
— skills treat either as a veto on new tracks.

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

Pure functions over OHLCV: **Wilder RSI (14, close)** on 1h and 4h timeframes,
volume z-score (24h window vs 7d baseline), range breakout (close beyond the
prior 7d high/low), EMA structure (9/21/50 on 1h), liquidity delta since last
snapshot.

The indicator contract is deliberately exact:

- UTC-aligned, fully closed candles only; the open candle is never an input
- candles are sorted and deduped by interval start, and a gap or duplicate makes
  the feature invalid rather than silently interpolated
- Wilder's initial average uses the first 14 gains/losses from 15 closes, then
  the standard recursive smoothing; average loss zero with positive gain yields
  100, average gain zero with positive loss yields 0, and both zero yields 50
- at least 10 of the latest 14 intervals must have non-zero volume; otherwise
  RSI is invalid rather than treating an inactive pool's flat print as neutral
- each value carries interval, period, method, source, pair, input start/end,
  last closed candle time, observed time, input count/hash, and validity reason
- snapshots include current and previous RSI plus delta for both timeframes;
  "rising" is never inferred from one point
- all indicators share a `feature_spec_version`; changing maths creates a new
  version and never retroactively relabels archived features
- a pair migration starts a new series and emits a discontinuity flag; candles
  from different pairs are never spliced into one RSI input

`exit_liquidity_risk` uses 1h RSI ≥ 70 as its initial overbought condition,
alongside its attention and liquidity clauses. Period, timeframes, overbought
threshold, and minimum active bars are explicit config values. A threshold
change creates a new config hash; historical flags are not relabelled.

Computed here (deterministic, testable) and written alongside references to the
content-addressed raw candles (snapshot-archive.md), so the agent interprets
numbers rather than recomputing them without duplicating candle payloads in every
run. The audit reuses the same timestamp-parameterised functions. Nothing reads
the wall clock internally; callers pass the as-of cutoff.

### Source call-event extraction

Source quality uses direct mention-time outcomes, not the bot's later decision.
Host code emits an eligible bullish call event only when raw text contains a
validated CA/pair plus an explicit positive-call pattern. The parser is
versioned, negation-aware, and conservative: warnings, neutral mentions,
ambiguous stance, and copied/retweeted duplicates are excluded and counted by
reason. It never calls a model and cannot assign one source's text to another
provenance id. Events carry source, cluster, identity, mention time, parser
version, matched rule id, raw-item hash, and dedupe key. Audit-metrics.md defines
pricing and scoring.

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
  `agent/state/sources.json` (auto-registered at neutral score by the snapshot
  writer's host-side post-step — never by an agent session, INV-S7) so the
  agent can weight evidence and the host can trace or extract auditable source
  call events (INV-S6)
- **Freshness and data quality are evidence** — every item carries `age_sec`
  and a `freshness_tier: live | stale | expired` derived from per-job
  thresholds (e.g. OHLCV older than 2h on a 1h chart-sweep = stale). Snapshots
  also flag missing fields and provider price disagreement (GeckoTerminal vs
  DexScreener beyond 2%) rather than papering over them. Skills treat
  `expired` social items as non-evidence for new tracks
- Raw text is carried verbatim inside `items` — collectors never "clean" it in ways
  that could hide manipulation, and never promote it into keys or filenames
  (dedupe fingerprints and cluster ids are *additional* fields, the raw text
  stays untouched)

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
