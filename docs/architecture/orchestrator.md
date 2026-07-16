---
description: Orchestrator module - job definitions, run loop, cursor-sdk session management, scheduling.
scope: module
status: draft
last_verified: 2026-07-16
read_when:
  - Editing src/orchestrator/, src/cli.ts, or ops/ schedules.
  - Changing how agent sessions are created, resumed, or disposed.
---

# Orchestrator

## Purpose

The only trusted, network-capable, always-scheduled component. It decides *when*
things happen and *what inputs* the runtime agent gets. It contains no trading logic
and no LLM prompting beyond the fixed job prompts.

## Responsibilities

- Define **jobs**: named pipelines of `collectors to run` + `agent prompt` + `expected
  outputs`. Planned v1 jobs:
  - `watchlist-scan` — tweets for each watched token → agent updates per-token notes,
    flags urgent signal
  - `list-scan` — curated Twitter list snapshot → agent extracts trends and new
    project candidates into the research queue
  - `research` — market data + socials snapshots for one candidate → agent produces a
    verdict (track / ignore / revisit) with reasoning
  - `chart-sweep` — OHLCV + computed indicators for watched tokens → agent flags
    early moves
  - `review` — periodic pass over the whole watchlist → agent proposes drops
- Run collectors, assemble `agent/inbox/<run-id>/`, then start the agent session
- Archive the inbox after the run and surface the report

## Design patterns

- **One shot per job**: prefer `Agent.prompt(...)` (one-shot, self-disposing) with
  `local: { cwd: <abs path to agent/> }` and `model: { id: "composer-2.5" }`. Use
  `Agent.create`/`send` only if a job genuinely needs follow-up turns.
- **Two failure kinds, two exit codes**: thrown `CursorAgentError` = run never
  started (env problem, exit 1); `result.status === "error"` = run failed mid-flight
  (inspect transcript, exit 2). Never conflate them.
- **Explicit config**: always pass `apiKey` and `local` explicitly; leave
  `settingSources` at its inline-only default so the service never inherits ambient
  user settings.
- Jobs are data (a typed registry), the run loop is one function. New flow = new job
  entry + new skill in the workspace, no new orchestration code.

## Key abstractions

- `Job` — name, collector list, prompt template, output contract
- `RunContext` — run id, timestamps, inbox path, job name; threaded through
  collectors and archived with the report
- Scheduling is dumb: launchd/cron calls `trench run <job>`; the CLI is idempotent
  and refuses to start a job whose previous run is still live (lockfile)

## Source files to inspect before editing (once implemented)

- `src/cli.ts` — entry point, job dispatch, locking
- `src/orchestrator/jobs.ts` — the job registry
- `src/orchestrator/run.ts` — collector orchestration + sdk session

## Gotchas and security-sensitive boundaries

- `CURSOR_API_KEY` lives in the orchestrator env only. It must never be written into
  `agent/` (the agent doesn't call the network and must not hold credentials).
- Log `run.id` and `agent.agentId` immediately after session start, before waiting —
  they are the only investigation handle if a run hangs.
- The job prompt is the only channel where we (not attackers) speak to the bot.
  Prompt templates must never interpolate raw scraped text — reference inbox files
  by path instead (INV-P2).
