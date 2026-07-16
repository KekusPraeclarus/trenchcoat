---
description: Orchestrator module - job registry, cron cycles, cursor-sdk session management, outbox validation with urgent bypass, alpha-queue lifecycle, performance-audit job.
scope: module
status: draft
last_verified: 2026-07-16
read_when:
  - Editing src/orchestrator/, src/cli.ts, or ops/ schedules.
  - Changing how agent sessions are created, how outbox items are sent, how the alpha queue is purged, or how audits score decisions and sources.
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
| `list-scan` | every 4h | curated twitter list; coingecko trending; dexscreener boosts; new-pool feed (security-gated, liquidity floor) | trends, candidates → research queue; **digests alpha queue** |
| `narrative-scan` | every 6h | reuses freshest list-scan + trending snapshots (no new fetch unless stale) | updates `state/narratives/`, detects prevailing-narrative shifts → outbox (few short sentences on why) |
| `research` | on queue, ≤ a few/day | market data + socials for one candidate | verdict (track / ignore / revisit) + research file, sources cited |
| `chart-sweep` | every 1h | OHLCV + indicators (RSI, vol z, EMA, breakout) for watched tokens | early-move flags |
| `review` | daily | light market refresh + fear & greed | drops/keeps, research distillation, index pruning; **digests alpha queue** |
| `audit` | weekly | outcome data: returns/liquidity since each past decision | scorecard update, **source-score update**, audit report |

Cadences live in `ops/` templates, not code; tune freely. Cron is the only trigger —
no daemon (the telegram listener excepted, see collectors.md), no human. The CLI
also accepts on-demand runs (operator or chat service).

Decision weighting is the bot's job, not ours: skills instruct it to blend
technicals with attention/sentiment/narrative evidence, weighted by each source's
score from `state/sources.json`. The orchestrator just guarantees those inputs
exist and are fresh.

## Run loop

Run collectors → assemble `agent/inbox/<run-id>/` → one-shot agent session →
validate + send outbox → archive inbox → purge digested alpha-queue items →
surface report.

## Alpha-queue lifecycle

The telegram listener appends continuously; digestion is batch:

1. Alpha-digesting jobs (`list-scan`, `review`) include the queue contents in scope
2. The agent records anything useful in the knowledge store (with provenance) and
   writes `inbox/<run-id>/alpha-digest.json` listing the message ids it processed
3. The orchestrator purges exactly those ids from `agent/alpha-queue/` after the
   run completes (INV-Q1) — knowledge survives in state, raw messages don't linger

## The audit job (performance + source scoring)

The agent's paper trail (`state/decisions.md`, append-only, every action with
reasoning, confidence, and cited sources) is the raw material. Weekly:

1. Orchestrator computes outcomes deterministically: for **every** verdict past its
   scoring horizon — `track` *and* `ignore`/`revisit` (counterfactuals) —
   price/liquidity change since the decision (GeckoTerminal), plus RSI-at-decision
   vs subsequent move for chart-call quality.
2. Orchestrator marks the **paper-trading ledger** (`state/ledger.json`):
   each track-call is a virtual position opened at decision price, closed at drop
   (or still open, marked to market). Opening and closing are deterministic
   consequences of decisions — the model never books ledger entries (INV-S10).
3. Agent session compares decisions vs outcomes: were track-calls early or late,
   were drops vindicated, what did the ignores do (missed alpha), were broadcasts
   (incl. urgent) justified, and is confidence calibrated (did 80-confidence calls
   hit ~80%?).
4. Source attribution: each decision's cited sources inherit its outcome; rolling
   per-source quality scores are updated in `state/sources.json`. Persistently bad
   sources get flagged in the audit report for the operator to consider removing.
5. Outputs: `state/scorecard.json` (paper P&L, track-call hit rate, drop precision,
   counterfactual miss rate, calibration curve, broadcast precision per severity,
   per-run token usage), updated `sources.json` + `ledger.json`, and
   `reports/audit-<date>.md` (narrative, lessons).

The paper P&L is the headline "is it doing a good job" number; lessons feed back
into the bot's skills only via a developer edit — the bot does not rewrite its own
instructions.

## Rug-shill docking (deterministic, immediate)

When the research security gate hard-fails a candidate (honeypot, live mint
authority, unlocked LP), the orchestrator immediately docks every source whose
provenance surfaced that candidate — no waiting for the weekly audit, no LLM in
the loop. Shilling a rug is the worst possible signal and the penalty is severe
and cumulative; repeat offenders are flagged for operator removal in the next
report. This is the one non-audit write path into `sources.json`, and it is
deterministic code, never a model session (INV-S7).

## Failure recovery ladder

Recovery is tiered; each tier only escalates if the one below can't resolve it:

1. **Deterministic self-healing (host-side, no LLM)** — the default for almost
   everything: listener death → launchd keepalive restarts it; failed or crashed
   run → `git checkout` of `agent/state/` to the last completed-run commit
   (INV-S8 makes this exact), inbox preserved for diagnosis, job re-queued with
   bounded retries; router down → outbox items queue for next cycle. Alpha queue
   is never touched by rollback (it lives outside the committed set, INV-Q1).
2. **Recovery agent (sandboxed, diagnostic + repair)** — spawned only when
   deterministic recovery fails twice on the same job, or a post-run integrity
   check flags inconsistent workspace state (e.g. watchlist/decisions mismatch
   that a rollback can't explain). Same sandbox, same workspace, its own skill
   (`skills/recover/`): read the failed run's inbox + partial outputs, repair
   state files *within existing invariants* (it cannot rewrite decisions.md —
   INV-S2 — or touch sources/ledger — INV-S7/S10), append a recovery entry to
   decisions.md, and write a diagnosis report. The orchestrator commits and
   re-queues the original job once.
3. **Operator DM (last resort + always for auth)** — anything the ladder can't
   fix, plus every needs-headful-reauth condition (never automated, by design)
   and every recovery-agent invocation (you should know it ran, even when it
   succeeded).

Recovery restores the *main agent's* flow; it never expands anyone's privileges —
the recovery agent is exactly as sandboxed as every other session (INV-S11).

## Outbox → router

- Agent writes proposals to `agent/outbox/<run-id>.json`; schema in
  `src/lib/outbox.ts`: `{ severity: "watch" | "notable" | "urgent", text: ≤ 280
  chars (narrative shifts: ≤ 3 short sentences), refs: [state paths] }`
- Budget rules: `watch`/`notable` consume the daily budget (default 5).
  **`urgent` bypasses the budget** — new narrative forming, sudden sentiment
  collapse, early chain rotation must never queue behind routine items. A failsafe
  ceiling (default 10 urgent/day) exists solely to contain a runaway agent; hitting
  it is an incident, not a tuning knob (INV-B4)
- Over-budget non-urgent items are logged in the run report as "not broadcast",
  never silently dropped
- POSTs to the external router (URL + auth from env). Router contract TBD — sender
  is a stub behind the `Broadcaster` interface until then
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

- `Job` — name, cadence hint, collector list, prompt template, output contract,
  `digestsAlphaQueue` flag
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
- `src/orchestrator/outbox.ts` — validation, budget + urgent bypass, router sender
- `src/orchestrator/audit.ts` — outcome computation (incl. counterfactuals),
  ledger marking, calibration, source attribution
- `src/orchestrator/alpha-queue.ts` — digest-then-purge lifecycle
- `src/orchestrator/recover.ts` — recovery ladder: rollback, retry, recovery agent
- `src/orchestrator/sources.ts` — rug-shill dock path (the only non-audit writer)

## Gotchas and security-sensitive boundaries

- `CURSOR_API_KEY`, router credentials, and Telegram credentials live in the
  orchestrator/chat env only — never under `agent/` (INV-I3)
- Broadcast text is downstream of untrusted tweets/alpha messages: the router
  sender transmits the schema-checked `text` field only, never raw snapshot
  content (INV-B2)
- The urgent bypass is the obvious abuse vector for a prompt-injected agent —
  that's what the failsafe ceiling and the audit's broadcast-precision-per-severity
  metric exist for; do not remove either (INV-B4)
- Purge only what the digest manifest lists — a crash between digest and purge must
  not lose undigested messages (INV-Q1)
- Log `run.id` and `agent.agentId` immediately after session start, before waiting —
  the only investigation handle if a run hangs
- Prompt templates never interpolate scraped text — reference inbox files by path
  (INV-P2)
- Audit outcome maths shares the rate-limit gate; a weekly audit over a large
  watchlist must chunk its GeckoTerminal calls (INV-R1)
