---
description: North star, deliverables, tech stack, and the framework decision for trenchcoat. The what and why of the project.
scope: project
status: active
last_verified: 2026-07-16
read_when:
  - You are new to the project or need the goal, stack, or a decision's rationale.
  - You are about to add a dependency, data source, or change the harness/model routing.
do_not_read_when:
  - You only need module internals (see docs/architecture/).
---

# Technical Spec — trenchcoat

## North star

**trenchcoat** — a fully autonomous agent that lives in the crypto trenches and
whispers you alpha. It maintains a token watchlist, reads Twitter and Telegram
alpha channels for signal, tracks the prevailing narrative, researches candidates,
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
     burner account: watched-token searches, curated trend list. No paid API.
   - *Telegram alpha channels* — operator-provided channel list; every new message
     lands in an **alpha queue**, digested on the next appropriate cycle, then
     purged (useful content is recorded in the knowledge store first).
   - *Market attention* — CoinGecko trending (coins + categories), DexScreener
     boosted/trending tokens.
4. **Narrative tracking** — the bot maintains a live model of what the trenches are
   talking about, positively and negatively (neobanks, privacy, RobinHood chain
   memes, Base AI, …) in `state/narratives/`. A shift in the prevailing narrative
   is broadcast to the router with a few short sentences on why.
5. **Chart analysis** — OHLCV from GeckoTerminal; deterministic indicators computed
   by collectors (RSI, volume z-score, breakouts, EMA structure); LLM interprets,
   never calculates.
6. **Source scoring** — every Twitter account and Telegram channel we read is a
   registered source in `state/sources.json`. Snapshots carry provenance per item;
   decisions cite their sources; the audit job attributes outcomes back to sources
   and maintains a rolling quality score that scan skills use to weight evidence.
   **Rug shilling is docked immediately and severely**: when a surfaced candidate
   hard-fails the security gate, every source that shilled it takes a deterministic
   credibility penalty the same run — no waiting for the weekly audit.
7. **Autonomous cron cycles** — launchd/cron fires every job with no human in the
   loop. On-demand runs remain available via the CLI and the chat agent.
8. **Performance self-audit** — append-only action log (`decisions.md`, with
   confidence and cited sources) plus a periodic `audit` job scoring past calls —
   including `ignore`s as counterfactuals — against realised outcomes into a
   scorecard: paper-trading P&L (the headline number), track-call hit rate, drop
   precision, confidence calibration, broadcast precision (per severity, urgent
   included), source quality deltas.
9. **Broadcasts** — brief key findings pushed to an **external router** (built
   separately; routes to Telegram/Discord). Sparingly and briefly. Severity
   `urgent` (new narrative forming, sudden sentiment collapse, early chain
   rotation) **bypasses the daily budget**; a generous hard ceiling exists purely
   as a runaway-agent failsafe.
10. **Chat agent** — a conversational agent reachable via Telegram to discuss
    findings, probe anything never broadcast, and give an opinion on any token.
    The chat session is a minimal orchestrator that delegates heavy work to
    research sub-agents to preserve its context window.

## Framework decision

**Chosen: Cursor agent harness as the framework.** A thin TypeScript orchestrator
(`@cursor/sdk`, local runtime, model `composer-2.5`) launches the trench agent with
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
  integrations we don't need (broadcast delivery is the external router's job);
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
| Neynar (Farcaster) | 10M credits/mo, 600 RPM | **Recommended, phase 2.** Crypto-native social graph, trending casts per channel; real free tier. Adds a second social lens with an actual API instead of scraping |
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
- **Agent harness**: `@cursor/sdk` (local runtime), model `composer-2.5`
  (normal, not fast), `CURSOR_API_KEY` from env
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
  - Neynar (Farcaster) — phase 2 candidate, free tier confirmed
- **Scheduling**: launchd (macOS) / cron invoking the orchestrator CLI
  (`trenchcoat run <job>`, alias `tc`)
- **Broadcast**: HTTP POST of outbox items to the external router (URL + auth from
  orchestrator env). The router is a separate project — we only know it exists and
  accepts brief findings for Telegram/Discord fan-out
- **Chat**: Telegram bot (long-polling) bridged to a minimal orchestrator session
  that spawns research sub-agents; see docs/architecture/chat-agent.md
- **State**: the hybrid file graph above, versioned by git for audit history

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
  schema-checked (length cap, severity, refs) before forwarding. `watch`/`notable`
  consume the daily budget; `urgent` bypasses it (failsafe ceiling only). The
  sandboxed agent can never reach the router directly.
- **Every piece of evidence has provenance.** Snapshot items carry their source
  handle; decisions cite sources; audits grade sources; scans weight by grade.
- **Autonomy with a paper trail, not a leash.** No approval gates anywhere; instead
  every action is logged with reasoning and the audit job scores it later.
- **Two documentation worlds.** `docs/` is for developers and the programming agent;
  `agent/` is the runtime bot's world. Boundary rule lives in root `AGENTS.md`.

## Resolved decisions

- Project name: **trenchcoat** (2026-07-16). Repo folder rename from `trench-bot`
  is a manual operator step (open IDE workspace)
- Twitter runs on a dedicated burner account (operator decision, 2026-07-16)
- No human-approval gate on watchlist changes; free agent control + retrospective
  audit (operator decision, 2026-07-16)
- Storage medium: hybrid file graph, no DB for v1 (see Storage decision above)
- Alpha sources: CoinGecko trending, DexScreener boosts, Fear & Greed in;
  CryptoPanic and LunarCrush out (no usable free tier); Neynar phase 2
  (see Alpha/news source research above)
- Telegram channel ingestion: **`t.me/s/` preview poller with GramJS fallback**
  (2026-07-16). Bot API bots cannot read channels without admin add, so no bot
  path exists. Per channel: poll the zero-credential HTML preview where enabled
  (no session, no flood-wait), fall back to a GramJS user session for channels
  without previews
- Token security pre-filter: **GoPlus** (EVM, free tier) + **RugCheck** (Solana,
  keyless basic lookups) gate every research verdict (2026-07-16, see
  Signal-quality roadmap)

## Signal-quality roadmap

Accepted quality improvements beyond the base flow, in adoption order. Items 1–7
are **designed into the module docs** (collectors, orchestrator, agent-workspace)
and carry invariants where warranted; 8–9 remain roadmap-only:

1. **Token security pre-filter (v1)** — before any research verdict: GoPlus token
   security API (EVM chains, free tier — the same source DexScreener's own risk
   warnings use) and RugCheck (Solana, keyless basic report). Hard-gate on
   honeypot/mint-authority/unlocked-LP flags; a token failing the gate is `ignore`
   with the flag cited, no LLM time spent.
2. **Attention–price divergence (v1)** — deterministic collector metric: mention
   velocity (twitter/alpha-queue counts) vs price move over the same window.
   Rising attention on a flat chart is the canonical early signal; attention
   spike after a 3x is exit liquidity. Feeds watchlist-scan and research.
3. **Counterfactual tracking (v1)** — `ignore` and `revisit` verdicts are logged
   with the same provenance as `track`; the audit prices them at the same horizons.
   Measures missed alpha and calibrates the research bar, not just the wins.
4. **Confidence calibration (v1)** — every decision entry carries a 0–100
   confidence; the audit plots calibration (were 80s right 80% of the time?).
   Cheap to record, catches systematic over/under-conviction.
5. **Paper-trading ledger (v1.5)** — a virtual position per track-call (entry at
   decision, exit at drop), marked by the audit job. Converts the scorecard into
   a hypothetical P&L — the single most honest "is it doing a good job" number.
6. **New-pool feeds (v1.5)** — GeckoTerminal new-pools / DexScreener new pairs as
   a discovery source *ahead* of social attention; strict security-gate + liquidity
   floor since this stream is 99% garbage.
7. **Narrative lifecycle stages (v1.5)** — `emerging → peaking → fading` on each
   narrative file rather than a boolean; rotation = capital leaving a fading
   narrative for an emerging one, which is exactly the urgent-broadcast case.
8. **Neynar/Farcaster lens (phase 2)** — second social surface, real free API.
9. **Smart-money wallet tracking (exploratory)** — free options are thin
   (Helius free tier for Solana is the leading candidate); revisit once v1 audits
   show what discovery actually lacks.

Deliberately not adopted: DexScreener boost-count as bullish signal (it's paid
marketing — we ingest it as attention *and* as a mild risk flag), generic news
RSS (low trench density), Reddit sentiment (no usable free quota — see source
research).

## Operational completeness (gaps closed at design level)

Identified in review as missing from the original design; owned as follows:

- **State commits** — the orchestrator `git add/commit`s `agent/state/` +
  `reports/` after every completed run (message = run id). The audit trail's
  "git history" claim is real only if commits are automatic (INV-S8).
- **Failure recovery ladder** — (1) deterministic self-healing: launchd restarts
  the listener, failed runs roll `agent/state/` back to the last completed-run
  commit and retry with bounds; (2) a sandboxed **recovery agent**
  (`skills/recover/`) spawns after repeated failures or integrity-check flags to
  diagnose and repair workspace state within existing invariants; (3) operator DM
  via the chat bot for what only a human can do (headful re-auth, always) and
  whenever the recovery agent ran. Detail in orchestrator.md; INV-S11.
- **Workspace concurrency** — one writer at a time: cron jobs and chat research
  sub-agents share a workspace-level lock; chat *reads* stay lock-free.
- **Token-usage telemetry** — per-run token counts from the sdk result land in
  the scorecard so burn-optimisation claims are measured, not vibes.
- **Cold start** — `trenchcoat init` seeds watchlist.json from the operator list,
  registers initial sources at neutral score, creates empty INDEX/narratives;
  first audit is skipped until decisions exist.
- **Retention** — archived inboxes and stale chat reports are pruned after 30
  days (configurable); state/ and decisions.md are never pruned.

## Open questions / pending decisions

- [ ] Router contract: exact endpoint, auth scheme, payload schema — pin down when
  the router project exists; until then the sender is a stub behind an interface
- [ ] Broadcast budget defaults: proposed max 5/day for watch/notable; urgent
  failsafe ceiling proposed at 10/day. Tune after the first weeks of audits
- [ ] Audit windows: score track-calls at +3d/+7d/+30d? Needs a few cycles of data
- [ ] Source-score maths: rolling hit-rate vs decayed weighting — pick when the
  first audit has real attributions
- [ ] Chart analysis depth: deterministic indicators + LLM read first; candle-image
  vision analysis later if audits show missed structure
- [ ] Paper-ledger position sizing convention (fixed notional per call vs
  confidence-weighted) — decide with the first ledger implementation
- [ ] Neynar/Farcaster integration timing (phase 2)

## Knowledge files needed (manual research pending)

Niche/fast-moving tech the model may hallucinate about; create under
`docs/knowledge/` as each area is first implemented:

- `cursor-sdk.md` — `@cursor/sdk` local runtime patterns, disposal, error split,
  session resume for the chat agent (a Cursor skill exists locally; distil the
  project-relevant subset)
- `cursor-sandbox.md` — `sandbox.json` schema, protected paths, macOS vs Linux
  enforcement differences
- `geckoterminal-api.md` — endpoints, OHLCV params, 30/min limit behaviour
- `dexscreener-api.md` — endpoints incl. boosts/profiles, per-endpoint limits,
  no-OHLCV gotcha
- `coingecko-demo-api.md` — trending endpoint, categories semantics, 10k/mo budget
- `playwright-twitter.md` — selectors, auth persistence, rate/ban avoidance,
  headful fallback triggers, burner-account hygiene
- `telegram-ingestion.md` — `t.me/s/` preview HTML structure and pagination;
  GramJS MTProto sessions, channel message events, flood-wait handling
- `telegram-bot-api.md` — long-polling, message threading, free-tier limits
- `goplus-rugcheck.md` — token-security endpoints, flag semantics (honeypot,
  mint authority, LP lock), free-tier limits, false-negative caveats
