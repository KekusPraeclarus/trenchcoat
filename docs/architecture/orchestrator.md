---
description: Orchestrator module - job registry, cron cycles, cursor-sdk session management, outbox validation and router forwarding, performance-audit job.
scope: module
status: draft
last_verified: 2026-07-16
read_when:
  - Editing src/orchestrator/, src/cli.ts, or ops/ schedules.
  - Changing how agent sessions are created, how outbox items are sent, or how audits score decisions.
---

# Orchestrator

## Purpose

The only trusted, network-capable, always-scheduled component. It decides *when*
things happen, *what inputs* the runtime agent gets, and *what leaves the machine*.
It contains no trading logic and no LLM prompting beyond the fixed job prompts.

## Jobs (v1 registry)

| Job | Cadence (initial) | Collectors | Agent output |
|---|---|---|---|
| `watchlist-scan` | every 2h | twitter search per watched token | per-token note updates, urgent flags |
| `list-scan` | every 4h | curated twitter list | trends, candidates → research queue |
| `research` | on queue, ≤ a few/day | market data + socials for one candidate | verdict (track / ignore / revisit) + research file |
| `chart-sweep` | every 1h | OHLCV + indicators (RSI, vol z, EMA, breakout) for watched tokens | early-move flags |
| `review` | daily | light market refresh | drops/keeps, research distillation, index pruning |
| `audit` | weekly | outcome data: returns/liquidity since each past decision | scorecard update + audit report |

Cadences live in `ops/` templates, not code; tune freely. Cron is the only trigger —
no daemon, no human. The CLI also accepts on-demand runs (operator or chat service).

## Run loop

Run collectors → assemble `agent/inbox/<run-id>/` → one-shot agent session →
validate + send outbox → archive inbox → surface report.

## The audit job (performance indicator)

The agent's paper trail (`state/decisions.md`, append-only, every action with
reasoning) is the raw material. Weekly:

1. Orchestrator computes outcomes deterministically: for each decision past its
   scoring horizon, price/liquidity change since the decision (GeckoTerminal), plus
   RSI-at-decision vs subsequent move for chart-call quality.
2. Agent session compares decisions vs outcomes: were track-calls early or late,
   were drops vindicated, what was missed, were broadcasts justified.
3. Outputs: `state/scorecard.json` (rolling metrics: track-call hit rate, drop
   precision, broadcast precision, avg return after call) and
   `reports/audit-<date>.md` (narrative, lessons).

The scorecard is the "is it doing a good job" answer; lessons feed back into the
bot's skills only via a developer edit — the bot does not rewrite its own
instructions.

## Outbox → router

- Agent writes proposals to `agent/outbox/<run-id>.json`; schema in
  `src/lib/outbox.ts`: `{ severity: "watch" | "notable" | "urgent", text: ≤ 280
  chars, refs: [state paths] }`
- Orchestrator validates schema, enforces the daily broadcast budget (default 5),
  drops the rest into the report as "not broadcast", and POSTs survivors to the
  external router (URL + auth from env). Router contract TBD — sender is a stub
  behind `Broadcaster` interface until then
- Send failures never fail the run; items queue for the next cycle

## Design patterns

- **One shot per job**: `Agent.prompt(...)` (self-disposing) with `local: { cwd:
  <abs path to agent/> }` and `model: { id: "composer-2.5" }`. `Agent.create`/`send`
  only where follow-up turns are genuinely needed (chat service, not jobs).
- **Two failure kinds, two exit codes**: thrown `CursorAgentError` = run never
  started (env problem, exit 1); `result.status === "error"` = run failed mid-flight
  (inspect transcript, exit 2). Never conflate them.
- **Explicit config**: always pass `apiKey` and `local` explicitly; leave
  `settingSources` at its inline-only default so the service never inherits ambient
  user settings.
- Jobs are data (a typed registry); the run loop is one function. New flow = job
  entry + skill in the workspace, no new orchestration code.

## Key abstractions

- `Job` — name, cadence hint, collector list, prompt template, output contract
- `RunContext` — run id, timestamps, inbox path, job name; threaded through
  collectors and archived with the report
- `Broadcaster` — interface over the router POST; stub until the contract exists
- Locking: the CLI refuses to start a job whose previous run is still live
  (lockfile); queued on-demand requests from the chat service go through the same
  gate

## Source files to inspect before editing (once implemented)

- `src/cli.ts` — entry point, job dispatch, locking
- `src/orchestrator/jobs.ts` — the job registry
- `src/orchestrator/run.ts` — collector orchestration + sdk session
- `src/orchestrator/outbox.ts` — validation, budget, router sender
- `src/orchestrator/audit.ts` — outcome computation for the audit job

## Gotchas and security-sensitive boundaries

- `CURSOR_API_KEY`, router credentials, and the Telegram bot token live in the
  orchestrator/chat env only — never under `agent/` (INV-I3)
- Broadcast text is downstream of untrusted tweets: the router sender transmits the
  schema-checked `text` field only, never raw snapshot content (INV-B2)
- Log `run.id` and `agent.agentId` immediately after session start, before waiting —
  the only investigation handle if a run hangs
- Prompt templates never interpolate scraped text — reference inbox files by path
  (INV-P2)
- Audit outcome maths shares the rate-limit gate; a weekly audit over a large
  watchlist must chunk its GeckoTerminal calls (INV-R1)
