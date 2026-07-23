---
description: Collectors module - Playwright Twitter, Neynar Farcaster, Telegram alpha listener, market-data clients (GeckoTerminal, DexScreener, CoinGecko trending, Fear & Greed), wallets/web, indicators incl. RSI, rate-limit gate, snapshot and provenance format.
scope: module
status: active
last_verified: 2026-07-22
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

### Adding a social/API source

1. New client under `src/collectors/` — all HTTP via the shared rate gate
2. Register the collector on the relevant job(s) in `src/orchestrator/jobs.ts`
3. Snapshot items carry provenance; neutral `sources.json` auto-registration
   stays host-owned
4. Update the data-sources table in `docs/TECHNICAL-SPEC.md` and add/refresh a
   `docs/knowledge/` file for the provider

### Fomo.family

Authenticated SPA scrape under `src/collectors/fomo/`. Host jobs:

- `fomo-trader-sync` (6h) — leaderboard handles → optional X nominations (no wallets)
- `fomo-signal-scan` (20m) — feed/trending/alerts → dated signals + bounded research enqueue
- `fomo-x-source-review` (6h) — one pending nomination → bounded X history + isolated classifier
- `fomo-narrative-source-scan` (6h) — live (≤6h) posts from narrative-probation handles
- `narrative-source-review` (daily) — utility promotion and gated X follow/unfollow

All snapshots are `trust: "untrusted-external"`. Historical X posts are tagged
`purpose=historical-source-evaluation` and never enter live narrative evidence.
Research dossiers may attach live `fomo-context` from the observation cache;
`narrative-scan` copies sealed fomo narrative posts into `narrative-social-fomo-x`
(excluding historical-purpose items). Shadow mode is the default. Knowledge:
[fomo-family.md](../knowledge/fomo-family.md).
FAFO status: [ops/fafo-fomo/REPORT.md](../../ops/fafo-fomo/REPORT.md).
ADR: [009-fomo-x-source-nomination.md](../adr/009-fomo-x-source-nomination.md).

X profile history scraping lives in `src/collectors/twitter/profile-history.ts`
and shares a crash-resumable page budget under
`archive/provider-usage/twitter/fomo-source-review/`. Per-nomination resume
checkpoints land at `archive/fomo-x-source-review/<nominationId>/progress.json`.

## Sources

### Twitter (Playwright)

- Dedicated **burner account**; credentials and the persistent auth profile live
  under `~/.trenchcoat/twitter-profile/` only (outside the repo, never inside
  `agent/` — the directory name is **not** `browser-profile`)
- Headless by default; when login or a challenge is detected, fail the run with a
  clear "needs headful re-auth" error — the operator runs `trenchcoat auth twitter`
  to fix it interactively. Never attempt automated challenge solving.
- Scrape targets: token search results (research job), FYP, exactly two immutable
  operator lists, and one bot-managed private source list
- **Research token search** — confirmed operator / queue research runs a bounded
  read-only X search (`scrapeResearchTokenTwitter`) using host-built queries from
  the resolved `(chain, tokenAddress, symbolDisplay)` only: token address, `$SYMBOL`,
  and `SYMBOL chain`. Each query tries Latest then Top if Latest is empty; the
  scraper waits for tweet articles (hydration race) before the first parse.
  Writes `twitter-token-search` (raw posts + engagement) and `twitter-popularity`
  (deterministic host summary: post count, unique authors, recent posts, known
  engagement totals/medians). Caps live under `config.research.twitter_search`.
  Missing auth/challenges produce `unavailable`/`degraded` summaries — never
  silent zero popularity. Sentiment classification stays model-side from untrusted
  tweet text with sample-size caveats. Research dossiers do **not** collect
  Farcaster (watchlist-scan may still use `research.farcaster_search`).
- Human-ish pacing (randomised delays, capped pages per run) to respect the platform
  and keep the account alive. Scrape read-only; never post, like, or follow.
  Mid-scrape browser death relaunches the read-only session once and continues
  remaining targets (`scrapeTargetsWithRecovery`); collect fails only if zero
  targets complete.
- **Streaming X scan** — production uses KeepAlive `com.trenchcoat.x-scan`
  (`tc listen x-scan`): one persistent Playwright session round-robins FYP then
  configured lists, scrolling each target until the last-read post id
  (`~/.trenchcoat/x-scan/cursors.json`), then runs **one batched** `list-scan` per round with
  injected scrape bundles. Random 5–30 minute delay between completed rounds.
  Challenge/login fails the target and backs off. Cron `list-scan` is retired.
- `list-scan` (legacy one-shot / streaming override) also writes path-only
  `list-scan-alpha-manifest` when not in streaming mode (capped at 500 with
  `truncated=N`) so alpha-queue digestion is not review-only; live Telegram
  digestion is primarily `telegram-alpha`. Twitter list/FYP
  snapshots and `x-fyp-eligible` use the same `SNAPSHOT_MAX_ITEMS` cap with a
  trailing `truncated=N` marker so oversized scrapes cannot fail collect on Zod
  `too_big`; `collectionStatus` may include `posts-truncated=N` (twitter/fyp) or
  `casts-truncated=N` (farcaster). FYP posts in the collection summary are
  pre-sliced to match the capped snapshot so engagement binding (INV-S22) cannot
  authorize likes on posts absent from `x-fyp-eligible`. Shared helper:
  `capEnvelopeItems` in `review-collect.ts` (alongside `capManifestLines`).

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

### Farcaster (Neynar)

- API-first via `api.neynar.com` (`NEYNAR_API_KEY`). No Playwright; no browser
  profile. Signer credentials live under `~/.trenchcoat/farcaster/signer.json`
  (mode 600, INV-I3) after `pnpm dev:cli auth farcaster`.
- Job `farcaster-scan` fetches for-you (bot FID), two optional operator channels,
  and the following feed. Host assessment tiers casts live ≤6h, stale ≤24h,
  expired >24h; rejects for-you when no live cast or a repeated-two-hash stale
  pattern, then makes **one** rate-gated Neynar `trending` fallback request
  (limit clamped to ≤10; no cursor retries, no cache-bust). Expired casts never
  enter inbox evidence.
  Analysis may proceed from any live configured feed or the trending fallback
  (`collectionStatus=analysis-only:…` when engagement is off); only verified
  live for-you casts enter the FYP like allowlist (`fypCasts`) — a stale
  for-you feed cannot authorize engagement. Structured receipt
  `farcaster-collection-receipt` records per-feed counts, rejection reason,
  fallback use, usable-evidence count, and `engagementDisabled`. Agent is
  skipped only when every bounded FC source is unusable (`skipAgent`);
  trending fallback alone keeps the agent on but is not personalized recovery.
  Status `empty-following-with-desired` means managed follows are desired but
  the following feed has zero non-expired eligible casts (see LIVE-E2E
  LIVE-E2E § Farcaster when for-you is stuck on `repeated_two_hash_stale`).
  Snapshots are `inbox/<runId>/farcaster-*.json` with
  `provenance: farcaster:@username` and `trust: untrusted-external`.
- Collection status reports dynamic signer probe output
  (`signerStatus=…`, `signerMutations=allowed|blocked`) — not a hard-coded gate string.
- Agent proposes likes only into `reports/<runId>/fc-engagement.json` (same-run
  for-you cast-hash confinement; max 2 likes / 10 minutes). Likes execute only
  when Neynar reports `approved` signer status. Cast publish and recast are
  structurally forbidden in the write client.
- Follow/unfollow is host-only via `fc-source-review` / `tc fc-source sync`
  (follow graph = managed list analog). Sync uses cursor pagination,
  idempotent already-following/not-following handling, post-sync refetch, and
  exact desired-vs-actual verification.
- Watchlist (not operator research): bounded cast search may write
  `farcaster-token-search` + `farcaster-popularity` when
  `research.farcaster_search.enabled`.

### Telegram alpha channels (preview poller + GramJS listener)

Bot API bots cannot read channels without being added by an admin, so no bot path
exists. Two ingestion modes, chosen per channel at config time:

- **Preview poller (preferred)** — public channels expose a zero-credential HTML
  preview at `t.me/s/<channel>` (paginated via `?before=<msg-id>`). Seed and
  runbook default every allowlisted channel to `mode: "preview"`. Poll on the
  collector cycle; no session, no flood-wait, no account risk. `t.me` is
  rate-gated (20/min); large allowlists stretch a cycle past the 30m sleep via
  the token bucket. Empty preview pages (disabled or private) accept nothing —
  there is no auto-flip to GramJS; switch those handles to `"gramjs"` manually.
- **GramJS (MTProto) listener (fallback)** — scaffold only for preview-disabled
  channels. Needs `~/.trenchcoat/telegram-session/session.txt` **and** a GramJS
  listener injected into `tc listen channels` (CLI does not inject one today).
  Without both, gramjs-mode channels log a warning and idle while preview
  channels keep flowing. `tc auth telegram-channels` remains unfinished —
  place a StringSession manually when you need the fallback.

Both modes append every new message to `agent/alpha-queue/<channel>/<msg-id>.json`
with full provenance and deduplicate on message id; digestion and purge are the
orchestrator's job (see orchestrator.md, INV-Q1). **Live path:** each newly
written message triggers a serial `telegram-alpha` agent pass (workspace lock,
full seal/purge/outbox). `list-scan`/`review` manifests remain for backlog.
Each append writes a same-directory temporary file, fsyncs it, then atomically
renames to the sanitised final path using create-if-absent semantics. A concurrent
listener/job can observe the old file or the complete new file, never a partial
message. Host service: `tc listen channels` (launchd `com.trenchcoat.channels`
KeepAlive) polls allowlisted `config.telegram_channels` (~60s default), checkpoints
cursors to `~/.trenchcoat/telegram-channels/cursors.json` after every accepted
message, and keeps GramJS sessions under `~/.trenchcoat/telegram-session/`
(never `agent/`). X streaming is separate KeepAlive `tc listen x-scan`.

### Token security gate

- **GoPlus** — `GET api.gopluslabs.io/api/v1/token_security/{chain_id}` (EVM
  chains, free tier, keyed via console): honeypot, mint authority,
  blacklist/whitelist, buy/sell tax, LP lock flags
- **RugCheck** — `GET api.rugcheck.xyz/v1/tokens/{mint}/report` (Solana, keyless
  basic lookups): mint/freeze authority, LP lock
- **`low-lp-lock` and active mint (`mintable` / `mint-authority`) are
  caution-only** — still flagged when locked-or-burned LP fraction is below
  `gate_thresholds.lp_locked_min` or mint authority is live, but never
  `hardFail` alone (security-gate.md). Host still blocks `track` for mintable
  memecoins via model classification. Remaining hard-fail fields are unchanged.
- Scanner selection per chain via the chain registry (chains.md); no scanner
  coverage → fail-closed, candidate untrackable
- Runs at research dequeue **and** as the new-pool stream filter; scheduled
  discovery hard-fails short-circuit to `ignore`. Confirmed operator research
  still produces an evidence report but cannot track/broadcast the token.
  Typed scanner failures can trigger the rug-shill dock. Exact field→flag mapping, thresholds, and the
  market-quality preflight (liquidity, txn, wash-filter floors) live in
  security-gate.md

### Chart-sweep (`collectChartSweep`)

Host collector for `chart-sweep`. Active watchlist subjects only
(`tracking` / `watching`):

1. Fetch closed **15m** OHLCV from GeckoTerminal (gated)
2. Aggregate to **1h** and **4h** via `aggregateClosedCandles`
3. Compute Wilder RSI (1h/4h), volume z-score, EMA structure, range breakout
4. Archive the raw 15m blob; write indicator snapshots; render 1h PNG charts +
   chart manifests (`candleHash` / `imageHash` / `sourceBlob`)

Empty active watchlist → host precondition skip in `runJob` before `createRunId`
(`archive/skips/chart-sweep.jsonl`, `runId: none`). Collector still defense-in-depth
skips with `collectionStatus: skipped` / `skipAgent: true` if reached. Zero charts
written after subjects → `degraded` + skip agent.

### Watchlist-scan (`collectWatchlistScan`)

Host collector for `watchlist-scan`. It reads active (`tracking` / `watching`)
watchlist entries without mutating them. Every valid bound identity receives a
DexScreener market snapshot and security-gate receipt. Config-enabled bounded X
and Farcaster token searches enrich the same subject but fail softly, preserving
market evidence. Empty active state is skipped by the host precondition gate
before `createRunId` (`archive/skips/watchlist-scan.jsonl`). Collector defense-in-depth
writes only `watchlist-collection-status` with `no-active-watchlist-subjects` and skips the
agent with zero network calls. After a non-empty scan, the agent runs only when
at least one subject has a successful market snapshot.

### Narrative-scan (`collectNarrativeScan`)

Reuses sealed **complete** archive inboxes — newest complete `list-scan` and
`farcaster-scan` journals only (failed/running excluded). Items older than
**24h are excluded**; **live ≤ 6h**, **stale ≤ 24h**. Market attention via
`fetchMarketAttentionForNarrative`: CoinGecko trending with bounded retry
(Demo key → coins + categories; keyless → coins only). On CG failure, DexScreener
boosts + GeckoTerminal new pools populate a fallback snapshot — always
`marketBlind=true` when categories are absent (`collectionStatus: degraded`).
`narrative-trending` is always written. Host rejects rotation/urgent-rotation
broadcasts when market-blind. Rotation and sentiment-collapse claims citing only
one social platform (X / Farcaster / Telegram) remain visible but are capped at
`watch` and rendered as `X-only` / `Farcaster-only` / equivalent; market and
FOMO provenance do not count as corroboration. `skipAgent` when `usableEvidence`
is false (no sealed social and no market items).
social reuse and no trending payload).

### Review collector (`review-collect.ts`)

Daily knowledge distillation (07:00 local cadence unchanged). Before creating a
run id, `evaluateReviewPrerequisites` requires traditional scope (sealed
complete reports in lookback, pending `alpha-queue/`, or active watchlist) **or**
health-derived scope from the shared snapshot: empty actionable research queue,
ambiguous depth, silent wallets, FC stale streak, recurring skip reasons,
incomplete/abandoned runs, or router ingress backlog. Otherwise one skip log
line and no run directory.

When scope exists, writes path-only inbox manifests — never report or alpha
bodies in the host prompt:

- `review-health-snapshot` — lock/runs/queues/X/FC/router/deploy warnings
- `review-skip-ledger` — aggregated `archive/skips/*.jsonl` reason counts
- `review-reports-manifest` — run ids + `reports/<run-id>/agent.md` paths
- `review-alpha-manifest` — pending `alpha-queue/<channel>/<msg-id>.json` paths
  (list-scan writes the same path-only shape as `list-scan-alpha-manifest`).
  Both manifests cap at `SNAPSHOT_MAX_ITEMS` (500) with a trailing
  `truncated=N` line so a preview backlog cannot fail collect on Zod `too_big`.
- `review-watchlist-snapshot` — bounded active subjects (≤30)
- `review-macro-snapshot` — fear/greed via `fetchFearGreed` (degraded if unavailable)

After integrity passes, accepted `state/research/` changes trigger host
`reconcileIndex` and an archived (+ report-mirrored) `index-reconcile-receipt.json`
with before/after INDEX hashes and source timestamps. Narrative-scan does the
same after prune. Alpha purge still follows validated
`reports/<run-id>/alpha-digest.json` after archive seal.

### Job collection routing (`collectForJob`)

Exhaustive switch in `src/orchestrator/collect.ts`:

| Kind | Jobs |
|---|---|
| **external** | `list-scan`, `farcaster-scan`, `watchlist-scan`, `chart-sweep`, `narrative-scan`, `research` (full dossier via `research-collect`), `review` (path-only manifests via `review-collect`) |
| **unavailable** | None |
| **host-only** | `source-list-review`, `fc-source-review`, `audit`, `outcomes-settle`, wallet jobs, `harness-improve`, `recover` — status snapshot, `skipAgent` |

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

### Wallet collectors (host-only)

- **Helius** — Solana verified swap-buys (`helius-provider.ts`): target mint gain
  + native/allowlisted quote spend; tip/`until` forward cursors; `getAccountInfo`
  for executable/program hard exclusions.
- **Infura / Robinhood** — EVM verified buys (`evm-provider.ts`): receipt + tx +
  block timestamp; `eth_getCode` for contract exclusions; Robinhood public RPC
  fail-closes on 429/5xx with 400-block work chunks.
- **Runner discovery** — GeckoTerminal new pools + DexScreener identity/liquidity
  + closed OHLCV → `wallet-runner-discovery` (ADR 020). Never feeds Fomo
  addresses into `wallets.json`.

## Rate-limit gate

One shared token-bucket per upstream host in `src/lib/`, consulted by every client
(including the audit job's outcome fetches and chat-triggered research). Takes are
serialized per host; optional `minIntervalMs` forces a wall-clock pause between
grants. Budgets set below published limits (GeckoTerminal 25/min, DexScreener
200/min, CoinGecko spread across the month, Infura Core 500 credits/s paced for
`eth_getLogs` at 255 credits — see `docs/knowledge/infura.md`). On 429: back off
per `Retry-After` if present, exponential otherwise; never tighten the loop.

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

## Source files to inspect before editing

- `src/orchestrator/collect.ts` — exhaustive job → collection-kind routing
- `src/orchestrator/chart-collect.ts` — chart-sweep OHLCV / indicators / PNG
- `src/orchestrator/narrative-collect.ts` — sealed social reuse + CoinGecko
- `src/orchestrator/review-collect.ts` — sealed report + alpha manifests for review
- `src/lib/rate-gate.ts` — the shared token bucket
- `src/lib/snapshot.ts` — the only writer into `agent/inbox/` and
  `agent/alpha-queue/`; enforces envelope + provenance
- `src/collectors/twitter/session.ts` — auth profile handling + engagement parse
- `src/collectors/twitter/scrape.ts` — list-scan + research token search
- `src/collectors/twitter/popularity.ts` — host query builder + popularity summary
- `src/collectors/farcaster/neynar.ts` — Neynar REST client
- `src/collectors/farcaster/scrape.ts` — for-you / channels / following feeds
- `src/collectors/farcaster/follow-sync.ts` — follow-graph membership sync
- `src/collectors/farcaster/engagement.ts` — likes applicator
- `src/collectors/farcaster/signer.ts` — host custody / KeyGateway setup (INV-A1)
- `src/collectors/telegram/listener.ts` — gramjs subscription, flood-wait handling
- `src/collectors/market/security.ts` — GoPlus/RugCheck mapping (LP + mint caution-only)
- `src/collectors/market/aggregate.ts` — 15m → higher-TF closed candle aggregation

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
