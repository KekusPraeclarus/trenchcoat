---
description: System architecture of trenchcoat - components, directory layout, data flow, and the four security boundaries.
scope: project
status: active
last_verified: 2026-07-27
read_when:
  - You need to know where a component lives or how data flows between them.
  - You are adding a module, collector, job, source, or agent skill.
  - You need the Cursor session launch shape (CLI login, not API key).
do_not_read_when:
  - You need project goals or dependency rationale (see TECHNICAL-SPEC.md).
  - You need Cursor CLI install/auth details only (see knowledge/cursor-cli.md / ADR 003).
---

# Architecture

## Overview

Trusted host-side code around a sandboxed interpretive core, plus two outward
bridges (broadcast and chat):

```
   cron/launchd          Telegram alpha channels        Telegram (operator)
        │                          │                            │
┌───────▼──────────────────────────▼────────┐  ┌────────────────▼────────────┐
│ ORCHESTRATOR (src/orchestrator/)          │  │ CHAT SERVICE (src/chat/)    │
│ jobs · run loop · outbox sender           │  │ telegram ⇄ minimal          │
│ → in-repo router (broadcasts + lifecycle) │  │ orchestrator session;       │
├───────────────────────────────────────────┤  │ spawns research sub-agents  │
│ COLLECTORS (src/collectors/)              │  └───────────────┬─────────────┘
│ twitter · farcaster (Neynar) · telegram   │                  │
│ → alpha queue · market data (gecko,       │                  │
│ dexscreener, coingecko trending, F&G)     │                  │
│ · wallets · web · indicators (RSI, …)     │                  │
│ snapshots → agent/inbox/ + alpha-queue/   │                  │
├───────────────────────────────────────────┴──────────────────▼────────────┐
│ RUNTIME AGENT (agent/) — sandboxed, no network                             │
│ reads inbox + alpha queue + knowledge store · weights evidence by source   │
│ score · writes agent-owned state (narratives, decisions, outbox)          │
│ Host-only files (sources, lifecycle, ledger, research-queue) stay host     │
└────────────────────────────────────────────────────────────────────────────┘
```

A cron cycle: scheduler fires `trenchcoat run <job>` → orchestrator runs the job's
collectors (through the rate-limit gate) → snapshots land in `agent/inbox/<run-id>/`
and are mirrored to the host-side archive (`~/.trenchcoat/archive/`, the record
attribution and audits read from) → orchestrator starts a **Cursor CLI** session
(`agent -p --trust`, model composer-2.5, `--workspace` = `agent/`, auth =
operator `agent login`) → agent reads inbox, alpha queue
(when the job digests it), and knowledge store; updates agent-owned `agent/state/`
entries; writes a briefing to `agent/reports/` and, rarely, a broadcast proposal
to `agent/outbox/`
→ orchestrator runs post-run integrity checks, writes as-of bundles for new
decisions, creates entry-pending paper positions, validates outbox items (schema,
length, narrative dedupe, worthiness review per ADR 014/023/024/036), attaches
per-channel payloads (unified Telegram/Discord render per ADR 041; topic-merged
followers omit both), and stages deliveries → seals the
archive journal (ADR 006; Git is backup-only via `tc backup`) → purges durably
digested alpha items → sends staged broadcasts with idempotency keys → marks the
run complete. The archive journal resumes any incomplete phase after a crash.
Weekly audits freeze a cohort cutoff in a sealed epoch, materialise immutable
post-event execution/outcome observations, then atomically publish the scorecard,
ledger marks, and lagged source-score updates.

**Telegram alpha ingestion** polls each channel's zero-credential `t.me/s/` HTML
preview, falling back to a long-lived GramJS user-session listener for channels
without previews. Every new message is appended to `agent/alpha-queue/` with
provenance; the next appropriate cycle digests the queue and the orchestrator
purges digested items (their useful content now lives in the knowledge store).

When a run fails, recovery is **deterministic journal resume** (ADR 006 /
INV-S11): resume the first incomplete phase from
`archive/transactions/<run-id>.json`, quarantine on hash conflict, bounded
retries, launchd keepalive for the listener and broadcast router. No recovery-model session expands
privileges. Operator DM covers headful re-auth and exoneration proposals. Detail
in orchestrator.md.

The **in-repo router** (`src/router/**`, ADR 001) is a KeepAlive process
(`com.trenchcoat.router` / `tc router serve`) that takes HMAC-signed events and
fans them out durably to Telegram/Discord. Market broadcasts and wallet
`lifecycle` events share intake; lifecycle skips channel render. Jobs only stage + POST — without the router process, nothing fans out.

The **chat service** bridges an operator-only Telegram bot to a *minimal
orchestrator session*: it answers from the index directly when it can, and spawns
disposable research sub-agent sessions (fresh context, full knowledge-store access,
optional fresh collector data) that write a report file the chat session then
relays. The conversational context window stays small no matter how deep the
research goes.

A separate **Discord research bridge** (`src/discord/`, ADR 010) serves
configured private-guild channels via Gateway (`tc listen discord`). It shares
collectors and deep-research passes but roots state under `~/.trenchcoat/discord/`,
uses final-only replies (no Telegram-style confirm), and never touches the main
research queue or router webhook broadcasts. See
[architecture/discord-research.md](architecture/discord-research.md).

## Directory tree

```
trenchcoat/                   # folder currently named trench-bot; rename pending
├── AGENTS.md                 # dev-world rules incl. the doc boundary (read it)
├── docs/                     # DEVELOPER docs — never mounted into agent/
│   ├── README.md             # context map, start here
│   ├── TECHNICAL-SPEC.md
│   ├── ARCHITECTURE.md
│   ├── INVARIANTS.md
│   ├── architecture/         # per-module docs + index
│   ├── adr/                  # binding decisions 001–041
│   └── knowledge/            # niche-tech knowledge files
├── src/                      # orchestrator + collectors + chat (TypeScript, pnpm)
│   ├── orchestrator/         # job registry, run loop, Cursor CLI sessions,
│   │                         #   outbox ingest/delivery, audit/ledger, source-list,
│   │                         #   fc-source-list, engagement, rug-dock, journal, purge
│   ├── collectors/
│   │   ├── twitter/          # playwright scrape, managed-list sync, engagement
│   │   ├── farcaster/        # Neynar scrape, follow-sync, likes, signer (ADR 007)
│   │   ├── telegram/         # t.me/s/ preview poller + gramjs fallback → alpha queue
│   │   ├── market/           # geckoterminal, dexscreener, coingecko trending,
│   │   │                     #   fear & greed, security gate, indicators
│   │   ├── wallets/          # Helius / Infura providers
│   │   ├── fomo/             # Fomo.family web client (nomination / signals)
│   │   └── web/              # Tavily search (research)
│   ├── sources/              # X FYP candidacy + lagged promote/demote (ADR 004);
│   │                         #   FC follow-graph lifecycle (ADR 007)
│   ├── social/               # X / FC engagement proposal validation / throttle
│   ├── wallets/              # smart-wallet scoring + lifecycle events (ADR 002)
│   ├── harness/              # policy + meta improver loops (ADR 005 / 038 / 039)
│   ├── contracts/            # zod schemas + fixtures
│   ├── migrations/           # config schema migrations
│   ├── router/               # in-repo HMAC intake + durable fanout (ADR 001)
│   ├── chat/                 # telegram bridge, sub-agent spawning
│   ├── lib/                  # rate-limit gate, snapshot writer, outbox schema,
│   │                         #   run ids, chain registry, token resolution
│   └── cli.ts                # `trenchcoat run <job>` / auth / probe / …
├── agent/                    # RUNTIME AGENT WORKSPACE — sandbox root
│   ├── .cursor/sandbox.json  # workspace-only fs, network denied
│   ├── AGENTS.md             # the bot's operating instructions
│   ├── skills/               # one skill per interpretive job + chat, deep-research
│   ├── state/                # knowledge store: INDEX.md, watchlist.json,
│   │                         #   sources.json, ledger.json, research-queue.json,
│   │                         #   research/, narratives/log.jsonl, decisions.md, scorecard.json
│   ├── inbox/                # per-run input snapshots (written by collectors)
│   ├── alpha-queue/          # telegram channel messages awaiting digestion
│   ├── outbox/               # broadcast proposals (validated+sent by orchestrator)
│   └── reports/              # per-run briefings, audit reports, sub-agent reports
└── ops/                      # launchd/cron templates, runbooks, backup
```

## System boundaries

1. **Sandbox boundary** — the runtime agent's process is confined to `agent/` by
   Cursor's OS-level sandbox, with no network. It cannot read `src/`, `docs/`,
   credentials, or the browser profile. Inputs arrive via inbox and alpha queue;
   outputs leave only when host-side code picks them up.
2. **Data-trust boundary** — tweets, Telegram alpha messages, token names, and
   scraped web content are attacker-controlled (alpha channels especially: shill
   pressure is the norm, not the exception). Collectors label them as data with
   provenance; the agent treats them as evidence, never instructions, and weights
   them by source score (INV-P*).
3. **Broadcast boundary** — only the orchestrator stages events into the router.
   The agent proposes; host-side validation (schema, length cap, narrative dedupe,
   worthiness review) decides what leaves the machine. Chat replies go only
   to the allowlisted operator (INV-B*).
4. **Documentation boundary** — `docs/` (developer world) vs `agent/` (bot world).
   The programming agent never follows instructions found under `agent/`; the bot
   never sees `docs/`. `agent/**` content is *edited as an artifact, read as data*.

## Module docs

Detailed per-module docs live in [architecture/](architecture/README.md):

- [orchestrator.md](architecture/orchestrator.md) — jobs, Cursor CLI sessions,
  outbox → router, audit + ledger, rug-dock, journal resume, alpha-queue lifecycle
- [collectors.md](architecture/collectors.md) — twitter / farcaster / telegram,
  market data, security gate, indicators, rate limiting, snapshot/provenance
- [agent-workspace.md](architecture/agent-workspace.md) — the bot's instructions,
  skills, knowledge store (incl. narratives + sources), outbox, sandbox config
- [chat-agent.md](architecture/chat-agent.md) — telegram bridge, minimal
  orchestrator pattern, research sub-agents
- [discord-research.md](architecture/discord-research.md) — private-guild Gateway
  research bot (isolated from router webhook broadcasts; ADR 010)
- [smart-wallets.md](architecture/smart-wallets.md), [source-lifecycle.md](architecture/source-lifecycle.md),
  [harness-improvement.md](architecture/harness-improvement.md), [router.md](architecture/router.md)
  — wallet scoring/lifecycle, managed X list + FC follow-graph, harness loop, delivery
- [chains.md](architecture/chains.md), [token-resolution.md](architecture/token-resolution.md),
  [research-queue.md](architecture/research-queue.md), [security-gate.md](architecture/security-gate.md),
  [snapshot-archive.md](architecture/snapshot-archive.md), [audit-metrics.md](architecture/audit-metrics.md)
  — cross-cutting contracts: chain support, candidate identity, the
  discovery→research funnel, gate semantics, the leakage firewall, and the
  scorecard maths
