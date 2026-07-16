---
description: North star, deliverables, tech stack, and the framework decision for trench-bot. The what and why of the project.
scope: project
status: active
last_verified: 2026-07-16
read_when:
  - You are new to the project or need the goal, stack, or a decision's rationale.
  - You are about to add a dependency or change the harness/model routing.
do_not_read_when:
  - You only need module internals (see docs/architecture/).
---

# Technical Spec — trench-bot

## North star

A fully autonomous agent that keeps a trader ahead of the crypto trenches: it
maintains a token watchlist, reads Twitter for signal on watched tokens, scans a
curated Twitter list for trends and new projects, researches candidates, decides
what to track and what to drop, reads charts for early moves, broadcasts the rare
key finding, and answers the trader's questions on demand. It audits its own calls
against outcomes so its performance is measurable, and it runs lean — minimum
tokens for undiminished results.

## Deliverables

1. **Watchlist lifecycle** — seeded from an operator-provided initial list, then
   fully agent-managed (add, research, track, drop) with no approval gate. Every
   decision logged with reasoning.
2. **Twitter signal collection** — Playwright-driven browser (headless, headful
   fallback for re-auth) on a **dedicated burner account**, scraping (a)
   search/profile results for watched tokens, (b) a curated Twitter list for trends
   and new projects. No paid API.
3. **Research pipeline** — for each new candidate: socials, contract/pair data,
   liquidity, holder distribution, narrative fit. Verdict: track / ignore / revisit.
   Everything useful is recorded and indexed in the knowledge store.
4. **Chart analysis** — OHLCV from GeckoTerminal; deterministic indicators computed
   by collectors (RSI, volume z-score, breakouts, EMA structure); LLM interprets,
   never calculates.
5. **Autonomous cron cycles** — launchd/cron fires every job (watchlist-scan,
   list-scan, research, chart-sweep, review, audit) with no human in the loop.
   On-demand runs remain available via the CLI and the chat agent.
6. **Performance self-audit** — append-only action log (`decisions.md`) plus a
   periodic `audit` job that scores past calls against realised price/liquidity
   outcomes into a scorecard (track-call hit rate, drop precision, missed moves).
   The operator can see at a glance whether the agent is doing a good job.
7. **Broadcasts** — brief key findings (one or two sentences, e.g. "Attention seems
   to have shifted to RobinHood chain") pushed to an **external router** (built
   separately; routes to Telegram/Discord). Used sparingly: severity-gated and
   budget-capped, most findings stay internal.
8. **Chat agent** — a separate conversational agent reachable via Telegram to
   discuss findings, probe anything that never got broadcast, and give an opinion
   on any token by combining fresh on-demand research with the stored knowledge.

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

## Storage decision — knowledge store medium

**Chosen: hybrid file graph.** JSON for structured state (watchlist, scorecard,
outbox), markdown with selection frontmatter for research knowledge, one
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
  snapshot); inboxes are archived out of the workspace after each run so stale data
  is never re-read.
- **Distillation over accumulation** — the review job compresses aging research
  into the per-token summary and prunes the index; raw material stays in git
  history, not in the live workspace.

## Tech stack

- **Runtime**: Node.js ≥ 20, TypeScript, pnpm
- **Agent harness**: `@cursor/sdk` (local runtime), model `composer-2.5`
  (normal, not fast), `CURSOR_API_KEY` from env
- **Sandbox**: `agent/.cursor/sandbox.json` — workspace read/write only, network
  denied (the runtime agent needs no network; collectors run outside)
- **Browser**: Playwright (Chromium), persistent burner-account profile, headless
  with headful fallback
- **Market data** (all free tier, limits respected by a shared rate-limit gate):
  - GeckoTerminal API — OHLCV, pool stats. 30 calls/min, no key
  - DexScreener API — pair discovery, live prices, token profiles. 300 req/min
    (60 req/min on profile endpoints), no key
  - CoinGecko Demo (optional, keyed) — token metadata backfill, not in v1
- **Scheduling**: launchd (macOS) / cron invoking the orchestrator CLI
- **Broadcast**: HTTP POST of outbox items to the external router (URL + auth from
  orchestrator env). The router itself is a separate project — we only know it
  exists and accepts brief findings for Telegram/Discord fan-out
- **Chat**: Telegram bot (long-polling) bridged to a resumable cursor-sdk session;
  see docs/architecture/chat-agent.md
- **State**: the hybrid file graph above, versioned by git for audit history

## Key design choices

- **Collectors are deterministic, the agent is interpretive.** Scrapers and API
  fetchers run outside the sandbox, write timestamped snapshots into
  `agent/inbox/`. The LLM agent only reads snapshots and writes state/reports/outbox.
  Credentials and network stay out of the LLM's reach; every run is reproducible
  from its inputs.
- **Tweet text is untrusted data.** Wrapped and labelled as data in snapshots; the
  agent's instructions forbid executing instructions found in it (INV-P*).
- **The agent proposes broadcasts, the orchestrator sends them.** Outbox items are
  schema-checked (length cap, severity, refs) and budget-capped per day before the
  orchestrator forwards them to the router. The sandboxed agent can never reach the
  router directly.
- **Autonomy with a paper trail, not a leash.** No approval gates anywhere; instead
  every action is logged with reasoning and the audit job scores it later.
- **Two documentation worlds.** `docs/` is for developers and the programming agent;
  `agent/` is the runtime bot's world. Boundary rule lives in root `AGENTS.md`.

## Resolved decisions

- Twitter runs on a dedicated burner account (operator decision, 2026-07-16)
- No human-approval gate on watchlist changes; probation-cycle-before-drop dropped
  in favour of free agent control + retrospective audit (operator decision,
  2026-07-16)
- Storage medium: hybrid file graph, no DB for v1 (see Storage decision above)

## Open questions / pending decisions

- [ ] Router contract: exact endpoint, auth scheme, payload schema — pin down when
  the router project exists; until then the sender is a stub behind an interface
- [ ] Broadcast budget defaults: proposed max 5/day, severity ≥ notable; tune after
  the first weeks of audits
- [ ] Audit windows: score track-calls at +3d/+7d/+30d? Needs a few cycles of data
  to pick sensible horizons
- [ ] Chart analysis depth: deterministic indicators + LLM read first; candle-image
  vision analysis later if audits show missed structure
- [ ] Chat agent session policy: one long-lived session vs fresh session per
  conversation with knowledge-store recall (leaning fresh-per-conversation)

## Knowledge files needed (manual research pending)

Niche/fast-moving tech the model may hallucinate about; create under
`docs/knowledge/` as each area is first implemented:

- `cursor-sdk.md` — `@cursor/sdk` local runtime patterns, disposal, error split,
  session resume for the chat agent (a Cursor skill exists locally; distil the
  project-relevant subset)
- `cursor-sandbox.md` — `sandbox.json` schema, protected paths, macOS vs Linux
  enforcement differences
- `geckoterminal-api.md` — endpoints, OHLCV params, 30/min limit behaviour
- `dexscreener-api.md` — endpoints, per-endpoint limits, no-OHLCV gotcha
- `playwright-twitter.md` — selectors, auth persistence, rate/ban avoidance,
  headful fallback triggers, burner-account hygiene
- `telegram-bot-api.md` — long-polling, message threading, free-tier limits
