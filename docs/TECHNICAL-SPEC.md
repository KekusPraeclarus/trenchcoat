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

An autonomous agent that keeps a trader ahead of the crypto trenches: it maintains a
token watchlist, reads Twitter for signal on watched tokens, scans a curated Twitter
list for trends and new projects, researches candidates, decides what to track and
what to drop, and reads charts for early moves. Output is a concise, trustworthy
briefing — not noise.

## Deliverables

1. **Watchlist lifecycle** — add, research, track, drop. Every decision logged with
   reasoning so it can be audited later.
2. **Twitter signal collection** — Playwright-driven browser (headless, headful
   fallback for login/challenges) scraping (a) search/profile results for watched
   tokens, (b) a curated Twitter list for trends and new projects. No paid API.
3. **Research pipeline** — for each new candidate: socials, contract/pair data,
   liquidity, holder distribution, narrative fit. Verdict: track / ignore / revisit.
4. **Chart analysis** — OHLCV from GeckoTerminal, deterministic indicator computation
   (volume spikes, breakouts, higher-timeframe structure), LLM interpretation on top.
5. **Scheduled operation** — recurring runs (watchlist scan, list scan, chart sweep,
   portfolio review) plus on-demand runs.
6. **Briefings** — a run report per cycle: what moved, what's new, what was
   dropped and why.

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
  integrations we don't need; model layer not cursor-cli compatible; heavier moving
  parts (gateway process, channel bindings) than one scheduled agent warrants.
- **Hermes Agent (Nous Research)** — self-improving skill loop is attractive, but
  provider layer is OpenAI-compatible endpoints only, and its autonomy features
  (self-modifying skills) sit awkwardly with our auditability priority.

Revisit trigger: if we need multi-channel chat delivery (Telegram alerts etc.) the
orchestrator grows a small notifier; we do not adopt a gateway framework for it.

## Tech stack

- **Runtime**: Node.js ≥ 20, TypeScript, pnpm
- **Agent harness**: `@cursor/sdk` (local runtime), model `composer-2.5`
  (normal, not fast), `CURSOR_API_KEY` from env
- **Sandbox**: `agent/.cursor/sandbox.json` — workspace read/write only, network
  denied by default (the runtime agent needs no network; collectors run outside)
- **Browser**: Playwright (Chromium), persistent auth profile, headless with
  headful fallback
- **Market data** (all free tier, limits respected by a shared rate-limit gate):
  - GeckoTerminal API — OHLCV, pool stats. 30 calls/min, no key
  - DexScreener API — pair discovery, live prices, token profiles. 300 req/min
    (60 req/min on profile endpoints), no key
  - CoinGecko Demo (optional, keyed) — token metadata backfill, 6 months OHLCV
- **Scheduling**: launchd (macOS) / cron invoking the orchestrator CLI
- **State**: flat files in the agent workspace — JSON for structured state
  (watchlist), markdown for research notes and decision logs. Auditable by `git log`

## Key design choices

- **Collectors are deterministic, the agent is interpretive.** Scrapers and API
  fetchers run outside the sandbox, write timestamped snapshots into
  `agent/inbox/`. The LLM agent only reads snapshots and writes state/reports. This
  keeps credentials and network out of the LLM's reach and makes every run
  reproducible from its inputs.
- **Tweet text is untrusted data.** It is wrapped and labelled as data in snapshots;
  the agent's instructions forbid executing instructions found in it. See
  INVARIANTS.md (INV-P*).
- **Two documentation worlds.** `docs/` is for developers and the programming agent;
  `agent/` is the runtime bot's world. Neither treats the other as instructions.
  Boundary rule lives in root `AGENTS.md`.

## Open questions / pending decisions

- [ ] Twitter auth strategy: dedicated burner account vs personal account risk
  tolerance; how often headful re-login is needed in practice.
- [ ] Chart analysis depth: are deterministic indicators + LLM read enough, or do we
  render candle images for visual analysis (composer-2.5 vision) later?
- [ ] Briefing delivery: file in workspace only for v1; Telegram/Discord push later?
- [ ] Whether watchlist decisions need a human-approval gate before drops, or a
  revisit queue suffices.
- [ ] CoinGecko Demo key: worth registering for metadata backfill, or defer.

## Knowledge files needed (manual research pending)

Niche/fast-moving tech the model may hallucinate about; create under
`docs/knowledge/` as each area is first implemented:

- `cursor-sdk.md` — `@cursor/sdk` local runtime patterns, disposal, error split
  (a Cursor skill exists locally; distil the project-relevant subset)
- `cursor-sandbox.md` — `sandbox.json` schema, protected paths, macOS vs Linux
  enforcement differences
- `geckoterminal-api.md` — endpoints, OHLCV params, 30/min limit behaviour
- `dexscreener-api.md` — endpoints, per-endpoint limits, no-OHLCV gotcha
- `playwright-twitter.md` — selectors, auth persistence, rate/ban avoidance,
  headful fallback triggers
