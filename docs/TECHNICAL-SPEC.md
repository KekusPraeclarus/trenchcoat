---
description: North star, deliverables, tech stack, and the framework decision for trenchcoat. The what and why of the project.
scope: project
status: active
last_verified: 2026-07-19
read_when:
  - You are new to the project or need the goal, stack, or a decision's rationale.
  - You are about to add a dependency, data source, or change the harness/model routing.
do_not_read_when:
  - You only need module internals (see docs/architecture/).
---

# Technical Spec — trenchcoat

## North star

**trenchcoat** — a fully autonomous agent that lives in the crypto trenches and
whispers you alpha. It maintains a token watchlist, reads Twitter, Farcaster, and
Telegram alpha channels for signal, tracks the prevailing narrative, researches candidates,
decides what to track and what to drop, reads charts for early moves, broadcasts
the rare key finding, and answers the trader's questions on demand. It audits its
own calls against outcomes — including how good each source was — and it runs
lean: minimum tokens for undiminished results.

## Deliverables

1. **Watchlist lifecycle** — seeded from an operator-provided initial list, then
   fully agent-managed (add, research, track, drop) with no approval gate. Every
   decision logged with reasoning.
2. **Multi-signal decisions** — every verdict blends quant/technicals (RSI, volume,
   structure, liquidity) with discretionary signals: Twitter attention, sentiment,
   and narrative fit. Evidence is weighted by the historical quality of its source
   (see 6). The blend rubric lives in the bot's skills, not in code.
3. **Signal collection**
   - *Twitter* — Playwright browser (headless, headful fallback) on a dedicated
     burner account: watched-token searches, FYP, two immutable operator lists,
     and one bot-managed private source list. No paid API.
   - *Telegram alpha channels* — operator-provided channel list; every new message
     lands in an **alpha queue**, digested on the next appropriate cycle, then
     purged (useful content is recorded in the knowledge store first).
   - *Market attention* — CoinGecko trending (coins + categories), DexScreener
     boosted/trending tokens.
4. **Narrative tracking** — a rolling log of trench narratives lives in
   `state/narratives/log.jsonl` (slug, stage, first/last seen, evidence). The log
   is host-owned/integrity-protected: the bot proposes updates in
   `reports/<run-id>/narrative-proposals.jsonl` and the host schema-merges them.
   New slugs or stage changes get a short `narrative-emergence` /
   `narrative-fade` (or `rotation`) broadcast; same-stage re-sightings only
   refresh the log. Host prunes entries older than
   `narratives.retention_days` (default 14) after each `narrative-scan`.
5. **Chart analysis** — OHLCV from GeckoTerminal; deterministic indicators computed
   by collectors (RSI, volume z-score, breakouts, EMA structure); LLM interprets,
   never calculates.
6. **Source scoring** — every Twitter account and Telegram channel we read is a
   registered source in `state/sources.json`. Snapshots carry provenance per item;
   decisions cite their sources; deterministic host code extracts conservative
   bullish CA call events and audits each from its own mention time to maintain a
   rolling quality score that scan skills use to weight evidence. Bot decisions
   and model-authored citations never write source scores.
   **Rug shilling is docked immediately and severely**: when a surfaced candidate
   hard-fails the security gate, every source that posted its contract address
   takes a deterministic credibility penalty the same run — no waiting for the
   weekly audit. The scoring pipeline is model-free by construction — host-side
   attribution over pre-session snapshot copies, typed scanner triggers,
   operator-only terminal exoneration — with one bounded exception: an isolated,
   fail-closed intent classifier (`shill`/`warn` only) that can suspend a dock
   for genuine warners but can never create a dock, raise a score, or stop the
   rug-adjacency counter. Prompt injection can neither vouch for a shiller nor
   frame a rival (INV-S12/S13).
7. **Autonomous cron cycles** — launchd/cron fires every job with no human in the
   loop. On-demand runs remain available via the CLI and the chat agent.
8. **Performance self-audit** — append-only action log (`decisions.md`, with
   confidence and cited sources) plus a periodic `audit` job scoring past calls —
   including `ignore`s as counterfactuals — against realised outcomes into a
   scorecard: paper-trading P&L (the headline number), track-call hit rate, drop
   precision, confidence calibration, broadcast precision (per severity, urgent
   included), source quality deltas. A separate **Harness Improvement Loop**
   (ADR 005; not Relative Strength Index) may propose one decision-policy
   experiment from sealed scorecards, evaluate on a holdout, and — when enabled —
   canary a bounded share of internal decisions with egress blocked; promotion is
   human-gated.
9. **Broadcasts** — brief key findings staged into the **in-repo SQLite router**
   (`src/router/**`, ADR 001) for Telegram/Discord fan-out. Sparingly and briefly
   on Discord: severity `urgent` (new narrative forming, sudden sentiment collapse,
   early chain rotation) **bypasses the Discord daily budget**; a generous hard
   ceiling exists purely as a runaway-agent failsafe. Telegram has no daily count
   limit after schema validation. Wallet add/drop uses a separate `lifecycle` lane
   that does not consume Discord market broadcast budget.
10. **Chat agent** — a conversational agent reachable via Telegram to discuss
    findings, probe anything never broadcast, and give an opinion on any token.
    The chat session is a minimal orchestrator that delegates heavy work to
    research sub-agents to preserve its context window.

## Framework decision

**Chosen: Cursor agent harness as the framework.** A thin TypeScript orchestrator
(Cursor CLI via `agent login`, model `composer-2.5`) launches the trench agent with
`cwd` set to `agent/`. The agent's behaviour is authored as markdown instructions and
skills inside that workspace. Deterministic collectors (scrapers, API fetchers,
indicator maths) are plain scripts whose output lands in the workspace for the agent
to read.

Rationale, against the hard constraints:

| Constraint | Why the Cursor harness wins |
|---|---|
| LLM via cursor-cli, composer-2.5 | Native. Eve routes through Vercel AI Gateway; OpenClaw and Hermes expect API-key providers (OpenAI-compatible endpoints). All three would need a custom provider shim maintained inside someone else's abstraction. |
| Fully sandboxed to working directory | Cursor sandbox is built in and OS-enforced (Seatbelt on macOS, Landlock + seccomp on Linux) via `agent/.cursor/sandbox.json`. The others sandbox via Docker or not at all, adding a second isolation layer to maintain. |
| Most easily customisable for this exact flow | Behaviour is markdown files we own end to end. No framework release cycle, plugin API, or gateway config between us and the flow. |
| Free-tier APIs, rate limits | Framework-agnostic; handled by our collectors either way. |

Rejected alternatives (as of Jul 2026):

- **Vercel eve** — excellent durable-execution and sandbox story, filesystem-first
  like our design, but model routing is AI Gateway-shaped and the runtime is built
  around Vercel Functions/Workflows. In beta; APIs may change. Strongest fallback if
  we ever drop the cursor-cli constraint and want hosted durability.
- **OpenClaw** — gateway/channel router for personal assistants. Strong messaging
  integrations we don't need (broadcast delivery is our in-repo router's job);
  model layer not cursor-cli compatible; heavier moving parts than warranted.
- **Hermes Agent (Nous Research)** — self-improving skill loop is attractive, but
  provider layer is OpenAI-compatible endpoints only, and its autonomy features
  (self-modifying skills) sit awkwardly with our auditability priority.

## Alpha/news source research (Jul 2026)

Surveyed for free-tier signal beyond Twitter, Telegram, and charts. Verdicts:

| Service | Free tier | Verdict |
|---|---|---|
| CoinGecko Demo `/search/trending` | 10k calls/mo, 30/min, keyed | **Adopt.** Trending coins *and categories* — categories are a direct narrative signal (e.g. "Base Native" trending) |
| DexScreener boosts/profiles | Free, no key, 60/min | **Adopt.** Boosted/trending tokens = paid-attention signal; client already exists |
| Neynar (Farcaster) | 10M credits/mo, 600 RPM | **Implemented.** Crypto-native social graph via for-you / channels / following; likes + follow-graph lifecycle (`farcaster-scan`, `fc-source-review`) |
| Alternative.me Fear & Greed | Free, keyless | **Adopt (trivial).** One call per review cycle for macro mood context |
| CryptoPanic | Free tier discontinued Apr 2026; from $50/wk | Rejected — not free |
| LunarCrush | Free tier is market-data only, no social/API | Rejected — social data starts ~$72/mo |
| Adanos (Reddit sentiment) | 250 req/mo | Not now — quota too small to matter; revisit if Reddit becomes a needed lens |
| Generic news RSS (CoinDesk etc.) | Free | Not now — low trench-alpha density; the Telegram channels cover news that matters faster |

## Storage decision — knowledge store medium

**Chosen: hybrid file graph.** JSON for structured state (watchlist, sources,
scorecard, outbox), markdown with selection frontmatter for research knowledge, one
always-small index (`state/INDEX.md`) as the retrieval entry point. No database.

Analysis of the three candidates:

| Medium | Retrieval by the agent | Auditability | Token cost | Verdict |
|---|---|---|---|---|
| Markdown graph + JSON | Native to the harness: read index → grep → open only matching files. Progressive disclosure for free. | Every change is a git diff | Low — index first, bodies on demand | **Chosen** |
| JSON only | Fine for structured state, poor for prose research; the agent would load whole blobs to find one fact | Diffable but noisy | Medium-high | Used for structured state only |
| Local DB (SQLite + FTS5) | Powerful search at scale, but needs CLI tooling in the sandbox and schema migrations | Opaque blobs; state changes stop being reviewable | Low at large scale only | Rejected for v1 |

Revisit trigger: adopt SQLite FTS5 for the research corpus only if retrieval starts
missing (audit shows the agent failing to recall recorded facts) or the index grows
past ~2k tokens despite pruning. Structured state stays JSON regardless.

## Token-budget discipline

Minimising burn without harming results, enforced by design rather than hope:

- **Deterministic pre-computation** — indicators (incl. RSI), returns since a
  decision, liquidity deltas are computed by collectors; the model never does maths
  it could read.
- **Index-first retrieval** — `state/INDEX.md` (one line per known token/narrative,
  with pointers) is the only always-read state file; everything else is opened on
  match. Per-token research files carry frontmatter summaries so the agent can skip
  bodies.
- **Per-job skills** — each cron job loads exactly one skill; the bot's always-on
  AGENTS.md stays under a strict size budget.
- **Bounded auxiliary sessions** — ticker disambiguation and rug-warning intent
  classification are isolated one-shot sessions, deduped/cached by input hash,
  daily capped, and included in token telemetry; cap exhaustion never expands
  privileges or bypasses a safety dock.
- **Snapshot hygiene** — collectors pre-filter (deduplicate tweets, cap items per
  snapshot); inboxes are archived out of the workspace after each run; the alpha
  queue is purged once digested.
- **Distillation over accumulation** — the review job compresses aging research
  into per-token summaries and prunes the index; raw material stays in git
  history, not in the live workspace.
- **Sub-agent isolation in chat** — the conversational session stays small; heavy
  research/collation runs in disposable sub-agent sessions that return a report.

## Tech stack

- **Runtime**: Node.js ≥ 20, TypeScript, pnpm
- **Agent harness**: Cursor CLI (`agent` / `cursor-agent`), model `composer-2.5`
  (normal, not fast), auth via `agent login` (see [CLI install](https://cursor.com/docs/cli/installation))
- **Sandbox**: `agent/.cursor/sandbox.json` — workspace read/write only, network
  denied (the runtime agent needs no network; collectors run outside)
- **Browser**: Playwright (Chromium), persistent burner-account profile, headless
  with headful fallback
- **Data sources** (all free tier, limits respected by a shared rate-limit gate):
  - GeckoTerminal API — OHLCV, pool stats. 30 calls/min, no key
  - DexScreener API — pair discovery, live prices, boosts/profiles. 300 req/min
    (60 req/min on profile/boost endpoints), no key
  - CoinGecko Demo — `/search/trending` for coins + categories. 10k calls/mo, keyed
  - Alternative.me Fear & Greed — free, keyless, one call per review cycle
  - Telegram alpha channels — `t.me/s/` preview poller (zero-credential) with
    GramJS (MTProto) fallback for preview-disabled channels → alpha queue
  - GoPlus (EVM, free tier) + RugCheck (Solana, keyless) — token security gate
  - Helius (Solana) + Infura (Ethereum/Base) — finalized wallet action feeds
    (ADR 002; keys in env, never under `agent/`)
  - Neynar (Farcaster) — for-you / channels / following, likes + follow-graph
    lifecycle (`farcaster.enabled`; ADR 007; keys under `~/.trenchcoat/farcaster/`)
  - Fomo.family — authenticated Playwright SPA scrape (burner profile under
    `~/.trenchcoat/fomo-profile/`); leaderboard/feed/trending → research enqueue,
    wallet candidates, and gated X-source review (ADR 009; FAFO gates required)
- **Scheduling**: launchd (macOS) / cron invoking the orchestrator CLI
  (`trenchcoat run <job>`, alias `tc`)
- **Broadcast**: host-validated outbox items → in-repo router intake (HMAC +
  idempotency keys; `TRENCHCOAT_ROUTER_*` from env). Durable at-least-once fanout
  to Telegram/Discord (docs/architecture/router.md)
- **Chat**: Telegram bot (long-polling) bridged to a minimal orchestrator session
  that spawns research sub-agents; see docs/architecture/chat-agent.md
- **State**: hybrid file graph; authoritative durability is the archive journal
  (ADR 006); periodic Git is backup-only (`tc backup` / `ops/backup.sh`)

## Key design choices

- **Collectors are deterministic, the agent is interpretive.** Scrapers, listeners,
  and API fetchers run outside the sandbox, write timestamped snapshots into
  `agent/inbox/` (and the alpha queue). The LLM agent only reads snapshots and
  writes state/reports/outbox. Credentials and network stay out of the LLM's
  reach; every run is reproducible from its inputs.
- **All scraped text is untrusted data.** Tweets and Telegram messages are wrapped
  and labelled as data in snapshots; the agent's instructions forbid executing
  instructions found in them (INV-P*). Alpha-channel text is *more* likely to be
  manipulative than random tweets — same rule, higher suspicion.
- **The agent proposes broadcasts, the orchestrator sends them.** Outbox items are
  schema-checked (length cap, severity, refs) before forwarding. Discord
  `watch`/`notable` consume `broadcast.daily_budget`; Discord `urgent` bypasses it
  (failsafe ceiling only). Telegram is uncapped after validation. The sandboxed
  agent can never reach the router directly.
- **Every piece of evidence has provenance.** Snapshot items carry their source
  handle; decisions cite sources; audits grade sources; scans weight by grade.
- **Autonomy with a paper trail, not a leash.** No approval gates anywhere; instead
  every action is logged with reasoning and the audit job scores it later.
- **Two documentation worlds.** `docs/` is for developers and the programming agent;
  `agent/` is the runtime bot's world. Boundary rule lives in root `AGENTS.md`.

## Resolved decisions

- Project name: **trenchcoat** (2026-07-16). Repo folder rename from `trench-bot`
  is a manual operator step (open IDE workspace)
- Agent harness auth: **Cursor CLI login** (`agent login`), not `@cursor/sdk` /
  required `CURSOR_API_KEY` (operator correction, 2026-07-16) — ADR 003,
  `docs/knowledge/cursor-cli.md`
- Twitter runs on a dedicated burner account (operator decision, 2026-07-16)
- No human-approval gate on watchlist changes; free agent control + retrospective
  audit (operator decision, 2026-07-16)
- Storage medium: hybrid file graph, no DB for v1 (see Storage decision above)
- Alpha sources: CoinGecko trending, DexScreener boosts, Fear & Greed, Neynar
  (Farcaster, ADR 007) in; CryptoPanic and LunarCrush out (no usable free tier)
  (see Alpha/news source research above)
- Telegram channel ingestion: **`t.me/s/` preview poller with GramJS fallback**
  (2026-07-16). Bot API bots cannot read channels without admin add, so no bot
  path exists. Per channel: poll the zero-credential HTML preview where enabled
  (no session, no flood-wait), fall back to a GramJS user session for channels
  without previews
- Token security pre-filter: **GoPlus** (EVM, free tier) + **RugCheck** (Solana,
  keyless basic lookups) gate every research verdict (2026-07-16, see
  Signal-quality roadmap)
- Multi-chain support via a **typed chain registry** mapping our chain slug to
  every provider's id, with per-chain scanner routing; chains without a
  registry entry or scanner are **fail-closed untrackable**. All chain access
  is API-driven — no RPC/node infrastructure; adding a chain is a registry
  entry + provider verification (2026-07-16, docs/architecture/chains.md)
- Canonical candidate identity: every candidate resolves to
  `(chain, token_address, pair_address)` before it is counted, researched, or
  tracked. Resolution is deterministic-first; when ticker matches are
  ambiguous, the agent makes a best-effort **model-judged disambiguation**
  from a deterministic dossier (market cap, liquidity, chart vs the message's
  claims), accepting only on high confidence — shortlist-bounded and inert to
  source scoring (INV-S16). Unbound mentions stay excluded from attention
  maths (2026-07-16, docs/architecture/token-resolution.md)
- Audit discipline: decision-time **as-of bundles** preserve what was knowable,
  first post-event observations price execution/outcomes, and sealed audit epochs
  make cohorts idempotent; source scores apply with a one-cycle lag
  (2026-07-16, docs/architecture/snapshot-archive.md, INV-S14/S18)
- Initial audit defaults (explicitly tunable after the first cycles, in
  docs/architecture/audit-metrics.md): horizons +24h/+72h/+7d with +72h
  headline; hit = +20% excess return vs the chain-native benchmark;
  paper-ledger sizing fixed $1k notional per call; source scores =
  30-day-half-life decayed hit rate (2026-07-16)
- Paper P&L convention: **action-realised + mark-to-market** — first eligible
  post-track observation enters, first post-drop observation exits, otherwise
  mark at the sealed audit cutoff; peak/MFE stays diagnostic only. Report gross
  and conservative cost-adjusted P&L beside a fixed +72h cohort return
  (2026-07-16)
- Ticker-only disambiguation is fully auditable: every verdict including
  abstains is logged with its versioned candidate feature dossier. Later raw CA
  supplies promotion-grade ground truth; price-derived target inference is
  proxy-labelled and exploratory. RSI tie-breakers require pre-registration,
  a forward holdout, minimum sample, and confidence-bound improvement before a
  reviewed deterministic promotion (2026-07-16,
  docs/architecture/token-resolution.md)
- Source quality is scored from conservative host-extracted bullish CA call
  events at mention time, not inherited from the bot's decision. Warnings,
  neutral/uncertain stance, and copies are excluded and measured; rug adjacency
  remains separate and immediate (2026-07-16,
  docs/architecture/audit-metrics.md, INV-S12)
- Discord broadcast budget initial defaults: 5/day watch+notable, urgent failsafe
  ceiling 10/day (Telegram uncapped after validation) — config values in
  docs/CONFIG.md, tune after the first weeks of audits (2026-07-16; Discord-only
  framing 2026-07-18)
- Broadcast delivery: **in-repo SQLite router** with HMAC intake, idempotency
  keys, and durable Telegram/Discord fan-out (2026-07-16, ADR 001,
  docs/architecture/router.md) — replaces the earlier "external router stub"
- Smart-wallet tracking host path: discovery/scan/review + blended scoring +
  lifecycle router lane (2026-07-16, ADR 002, docs/architecture/smart-wallets.md)
- Harness Improvement Loop: sealed-scorecard hypotheses, confined worktrees,
  scheduled PR-only path, bounded canaries (2026-07-16, ADR 005)

## Signal-quality roadmap

Accepted quality improvements beyond the base flow, in adoption order. Items
1–16 are **designed into the module docs**; 15–16 have host implementation paths
(live E2E still gated where noted):

1. **Token security pre-filter (v1)** — before any research verdict: GoPlus token
   security API (EVM chains, free tier — the same source DexScreener's own risk
   warnings use) and RugCheck (Solana, keyless basic report). Hard-gate on
   honeypot/mint-authority/unlocked-LP flags; a token failing the gate is `ignore`
   with the flag cited, no LLM time spent. Exact mapping: security-gate.md.
2. **Canonical identity resolution (v1)** — CA-first resolution to
   `(chain, token_address, pair_address)` before anything is counted or
   researched; ambiguous tickers get best-effort model-judged disambiguation
   against a deterministic dossier, high-confidence acceptance only
   (token-resolution.md, INV-S16). Kills wrong-asset research, mention
   counting, and attribution.
3. **Mention dedupe + independence clusters (v1)** — copy-paste/retweet
   collapse and Sybil-resistant cluster counting; divergence and corroboration
   run on *effective* mentions (collectors.md).
4. **Attention–price divergence (v1)** — deterministic collector metric:
   effective mention velocity vs price move over the same window, with
   `late_attention` and `exit_liquidity_risk` veto flags. Rising attention on
   a flat chart is the canonical early signal; attention spike after a 3x is
   exit liquidity.
5. **Market-quality preflight (v1)** — liquidity floor, txn count, wash-trade
   ratio, FDV/liquidity bound on every research path, not just new pools
   (security-gate.md). Rug flags don't catch untradeable.
6. **Counterfactual tracking (v1)** — `ignore` and `revisit` verdicts are logged
   with the same provenance as `track`; the audit prices them at the same horizons.
   Measures missed alpha and calibrates the research bar, not just the wins.
7. **Decision cards + confidence calibration (v1)** — every decision entry is a
   structured card (thesis, horizon, invalidation, drivers, countercase,
   confidence 0–100, gate status — agent-workspace.md); the audit plots
   calibration per confidence bin *and per driver*.
8. **Leakage-free audits (v1)** — as-of bundles freeze evidence-time values;
   immutable post-event observations price execution and outcomes; sealed epoch
   manifests freeze cohorts and versions; source scores apply with a one-cycle
   lag so feedback loops are cut by construction
   (snapshot-archive.md, audit-metrics.md, INV-S14/S18).
9. **Freshness + data-quality flags (v1)** — every snapshot item carries
   `age_sec`, a freshness tier, and provider-disagreement/missing-field flags;
   expired social evidence can't drive a new track (collectors.md).
10. **Paper-trading ledger (v1.5)** — a virtual position per track-call (entry at
    the first post-decision observation, exit at the first post-drop observation),
    marked by the audit job. Headline action P&L is reported realised + MTM,
    gross + cost-adjusted, raw + benchmark-hedged, beside fixed-horizon cohort
    return; hindsight peak exits are diagnostics only.
11. **New-pool feeds (v1.5)** — GeckoTerminal new-pools / DexScreener new pairs as
    a discovery source *ahead* of social attention; strict security-gate + liquidity
    floor since this stream is 99% garbage.
12. **Discovery-funnel counterfactuals (v1.5)** — everything rejected or
    expired before research lands in a host-side discovery log and gets priced
    at the same horizons: filter recall loss and gate catch rate are what tune
    every threshold (audit-metrics.md).
13. **Narrative lifecycle stages** — `emerging → peaking → fading` on each
    `log.jsonl` entry (optional richer notes in `narratives/<slug>.md`);
    broadcast fires on **new slug append** or **stage change** (heat up/down);
    same-stage re-sightings stay silent (host-enforced). Rotation = capital
    leaving a fading narrative for an emerging one → canonical `urgent`.
14. **Regime-stratified scorecards (v1.5)** — hit rate and calibration split by
    macro regime (Fear & Greed + chain-benchmark volatility percentile) once
    enough decisions exist; a bot that only works in a bull tape should say so.
15. **Neynar/Farcaster lens (shipped host path)** — for-you / channels / following
    scrape, likes-only engagement, follow-graph lifecycle as managed-list analog
    (ADR 007; `farcaster-scan`, `fc-source-review`). Live E2E gated on Neynar
    signer + `farcaster.enabled`.
16. **Smart-money wallet tracking (shipped host path)** — Helius/Infura/Robinhood
    discovery + scan + review jobs, blended scoring (ADR 002), operator seed, and
    `wallet.lifecycle` router events. Live E2E still gated on provider keys
    (INV-S19/S20 PARTIAL; ops/LIVE-E2E-BLOCKERS.md).

Deliberately not adopted: DexScreener boost-count as bullish signal (it's paid
marketing — we ingest it as attention *and* as a mild risk flag), generic news
RSS (low trench density), Reddit sentiment (no usable free quota — see source
research).

## Operational completeness (gaps closed at design level)

Identified in review as missing from the original design; owned as follows:

- **Archive-authoritative journal** — completed-run durability is
  `archive/transactions/<run-id>.json` sealed before alpha purge or egress
  (ADR 006 / INV-S8). Periodic Git (`tc backup`) is backup-only and never gates
  completion.
- **Failure recovery** — (1) deterministic journal resume + quarantine on hash
  conflict, launchd keepalive for the listener, bounded retries (INV-S11); (2)
  operator DM via the chat bot for headful re-auth and every **exoneration
  proposal** (`warn` intent on a rug-adjacent source) for manual undock/confirm.
  No recovery-model session expands privileges. Detail in orchestrator.md /
  chat-agent.md; INV-S11 / INV-S13.
- **Workspace concurrency** — one writer at a time: cron jobs, chat research
  sub-agents, and recovery actions share a workspace writer lock; chat *reads*
  stay lock-free (INV-S15, orchestrator.md).
- **Operator contract** — env vars, config file, seed format, tunable
  thresholds, and the CLI surface are pinned in docs/CONFIG.md; deployment and
  procedures in ops/runbook.md + launchd templates.
- **Token-usage telemetry** — an append-only host log records the main session
  plus auxiliary disambiguation/intent sessions per run; the weekly scorecard
  rolls up tokens by job/session kind alongside cache hits and useful outcomes,
  so burn-optimisation claims are measured, not vibes.
- **Cold start** — `trenchcoat init` seeds watchlist.json from the operator list,
  registers initial sources at neutral score, creates empty INDEX/narratives;
  first audit is skipped until decisions exist.
- **Retention** — archived inboxes and stale chat reports are pruned after 30
  days (configurable); state/ and decisions.md are never pruned.

## Open questions / pending decisions

- [ ] Chart analysis depth: deterministic indicators + LLM read first; candle-image
  vision analysis later if audits show missed structure
- [ ] Confidence-weighted paper-ledger sizing — only after calibration is proven
  over several audit cycles (fixed $1k notional until then)

Formerly open, now resolved with **initial defaults, revisit after the first
audit cycles** (recorded under Resolved decisions): broadcast budgets (5/day +
urgent ceiling 10), audit windows (+24h/+72h/+7d, +72h headline), source-score
maths (30d-half-life decayed hit rate, lag-applied), ledger sizing (fixed
$1k notional). Wallet vote archival completeness (ADR 002) — closed 2026-07-18:
`wallet-review` archives evidence card hash, prompt hash, raw output, and
contribution.

## Knowledge files

Niche/fast-moving tech under `docs/knowledge/`. Present today:

- `cursor-cli.md`, `helius.md`, `infura.md`, `x-playwright.md`, `telegram.md`,
  `discord.md`, `market-risk.md`, `neynar.md`, `tavily.md`

Still useful to deepen when those surfaces first go live hard:

- `cursor-sandbox.md` — `sandbox.json` schema, protected paths, macOS vs Linux
- `geckoterminal-api.md` / `dexscreener-api.md` / `coingecko-demo-api.md`
- `goplus-rugcheck.md` — flag semantics and false-negative caveats
