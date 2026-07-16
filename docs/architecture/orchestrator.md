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
| `research` | on queue (research-queue.md), daily cap from config | market data + socials for one candidate | verdict (track / ignore / revisit) + research file, sources cited |
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

Run collectors → assemble `agent/inbox/<run-id>/` **and copy it into the
host-side archive** (`~/.trenchcoat/archive/`, snapshot-archive.md — the
tamper-proof record scoring and audits read from) → one-shot agent session →
post-run integrity checks (host-only files unchanged, decision cards
well-formed, INV-S9 cross-reference) → write **as-of bundles** for any new
decisions (snapshot-archive.md) → create/finalise pending ledger actions →
validate and stage outbox deliveries → commit state + reports (INV-S8) → purge
only durably digested alpha items → deliver staged outbox items → atomically mark
the run complete → surface report. Delivery failures remain queued and do not
uncommit an otherwise valid run.

Post-run checks distinguish two write phases: agent-phase (host-only files —
`sources.json`, `ledger.json`, `research-queue.json`, `scorecard.json` — must
be byte-identical before vs after the session) and orchestrator-phase (the run
loop's own deterministic writes after the checks pass). INV-S7/S10 are
assertions about the agent phase; orchestrator-phase writes are the designed
mechanism, not violations.

## Workspace locking

One writer at a time, two levels:

- **Workspace writer lock** (`agent/.lock`, host-side flock) — held by any cron
  job run, chat research sub-agent run, or recovery action for its full
  duration. `tc run` exits 3 if held; queued on-demand requests wait.
- **Job-level guard** — the CLI additionally refuses to start a job whose
  previous run is still live, so a slow job can't stack on itself.

Chat *reads* (the conversational session answering from INDEX/reports) take no
lock — they tolerate a mid-run snapshot of state. Anything that writes state
goes through the writer lock (INV-S15).

## Run idempotency and crash consistency

Every run has a host-side journal keyed by `run_id`, with monotonic phases and
hashes for collector archive, checked agent diff, decision bundles, host state
mutation, git commit, alpha purge, outbox delivery, and completion. Each phase is
fsynced and atomically renamed. Recovery resumes the first incomplete phase; it
does not replay earlier side effects.

Idempotency keys are structural:

- decision bundle and ledger position: `decision_id`
- alpha knowledge/digest/purge: provenance + message id
- source call event: raw-item hash + parser version
- outbox delivery: run id + validated item hash, passed to the router as its
  required idempotency key
- git commit: run id in commit metadata, with the committed tree hash in journal

Host records prepared before a failed git commit remain unsealed and ineligible
for audits. Commit failure retries while the lock is held; after bounded failure,
state rolls back to the prior completed commit, the journal stays diagnostic,
and no alpha purge or external delivery occurs. A crash after commit resumes
purge/delivery from their keys. The completed marker is written only after the
commit exists and all non-delivery integrity phases pass. Pending router
deliveries are allowed and visible.

The router contract must honour the idempotency key. Until that contract exists,
the stub records delivery intent but does not claim exactly-once external sends.

## Alpha-queue lifecycle

The telegram listener appends continuously; digestion is batch:

1. Alpha-digesting jobs (`list-scan`, `review`) include the queue contents in scope
2. The agent records anything useful in the knowledge store (with provenance) and
   writes `inbox/<run-id>/alpha-digest.json` listing the message ids it processed
3. After the state/report commit is durable, the orchestrator purges exactly
   those ids before the completed marker (INV-Q1) — a retry sees the keyed purge
   as already satisfied; knowledge survives in state and raw messages don't linger

## The audit job (performance + source scoring)

The agent's paper trail (`state/decisions.md`, append-only, every action with
reasoning, confidence, and cited sources) is the raw material. Weekly:

1. Orchestrator freezes an **audit epoch** before fetching anything: immutable
   cutoff, eligible event ids, config/code/feature/execution versions, prior
   source-score cutoff, and input hashes. A rerun resumes or verifies that epoch;
   it never silently forms a new cohort (snapshot-archive.md).
2. It materialises immutable outcome observations for every eligible directional
   verdict (`track` and `ignore`; `revisit` is latency/disposition only), source
   call event, resolution verdict, broadcast, and sampled discovery-log item.
   Pricing uses first post-event execution observations, benchmark-adjusted
   returns, explicit missing/censored states, and versioned RSI-at-decision
   features (audit-metrics.md).
3. It marks the **paper-trading ledger** (`state/ledger.json`): each track-call
   becomes a virtual position at the first post-decision execution reference,
   closes only on a drop at the first post-drop reference, or remains marked to
   market. Opening, finalising, and closing are deterministic consequences of
   decisions — the model never books ledger entries (INV-S10).
4. Deterministic host code computes scorecard aggregates. The audit agent receives
   only the frozen figures and compares decisions vs outcomes: were track-calls
   early or late, were drops vindicated, what did ignores do, were broadcasts
   justified, and is confidence calibrated?
5. Source scoring uses direct, deduped bullish call events extracted from raw
   archived messages and priced from mention time. It does not inherit the bot's
   decision outcome and excludes warnings/neutral/uncertain stance. Rolling
   scores are updated only after epoch checks pass.
6. Outputs: sealed epoch + outcome records, `state/scorecard.json`, updated
   `sources.json` + `ledger.json`, and `reports/audit-<date>.md`.

The action-realised + mark-to-market paper P&L and fixed +72h cohort return are
the paired headline numbers. Peak-close is MFE diagnostics, never booked P&L.
Lessons feed back into skills only via a developer edit — the bot does not
rewrite its own instructions.

The audit narration runs as a fresh one-shot session with no tools or workspace
access. Host code supplies one hash-bound epoch summary containing the computed
figures and bounded decision-thesis excerpts needed for explanation. It excludes
live inboxes, current market snapshots, mutable watchlist state, raw scraped
text, and unsealed outcomes. Host code publishes every number before the session;
the session returns narrative text only.

## Source scoring pipeline (model-free by construction)

`sources.json` is the highest-value injection target in the system: if scraped
text could influence credibility scores, a shiller could vouch for their own
channel or frame a rival. So every write follows one pipeline in which **no
model-authored artifact participates** (INV-S12):

```
host-side snapshot archive ──> deterministic attribution ──> score write
(collector output, copied      (raw item text contains the    (dock or audit
 before the agent session)      candidate's contract/pair      scoring maths)
                                address within the lookback
        typed scanner/outcome    window — plain string match)
        results (in memory) ──────────────┘
```

- **Attribution** — a source is linked to a candidate iff its *raw* items mention
  the token's contract or pair address (canonical identity from
  token-resolution.md), matched by host code over the archive's pre-session
  snapshot copies (snapshot-archive.md) within a **7-day lookback window**
  (config). Never from the research queue, `decisions.md` citations, or anything
  else the agent wrote: a session-authored file can name any source, a raw item
  can only incriminate the provenance that actually posted it
  (collector-stamped, INV-S6). The dock runs wherever the scanner produces a
  typed hard-fail — research dequeue and the new-pool filter alike — so
  shillers are docked even for candidates that never reach a research session.
- **Rug-shill dock (immediate)** — triggered only by the typed GoPlus/RugCheck
  response hard-failing a candidate (honeypot, live mint authority, unlocked LP).
  Every attributed source takes a severe cumulative penalty in the same run;
  repeat offenders are flagged for operator removal in the next report.
- **Audit scoring (weekly)** — direct source-call extraction scans the same
  pre-session archive for raw CA/pair matches plus an explicit bullish pattern.
  A deterministic, versioned, negation-aware parser excludes warnings, neutral
  mentions, uncertain stance, and deduped copies; exclusions and parser coverage
  are reported. Eligible events are priced from their own mention timestamps
  (audit-metrics.md), not from a bot decision they influenced. Scores apply with
  a **one-cycle lag**: runs weight evidence with start-of-run snapshots, and an
  epoch includes only source events before the prior score cutoff (INV-S14,
  snapshot-archive.md). The audit agent interprets and narrates; it never
  computes or writes scores, and its citations never enter scoring.
- **Intent classifier (bounded leniency)** — deterministic CA-matching cannot
  distinguish shilling from warning, so each matched item passes through a fresh,
  isolated classifier session before the dock is finalised: no tools, no
  knowledge store, a fixed host-side prompt template (never a workspace skill),
  the single message supplied as a quoted data file (INV-P2 style). Output must
  be exactly `shill` or `warn`; **anything else fails closed to `shill`**
  (INV-S13). The verdict is one constrained enum consumed by deterministic code
  and can only attenuate:
  - `shill` → full dock, immediately (unchanged)
  - `warn` → immediate penalty suspended; an exoneration proposal is persisted
    to the host-side queue (`~/.trenchcoat/archive/exonerations.json`, outside
    the workspace — the agent never sees or influences it) and **immediately
    DMed to the operator via the chat bot** for manual review:

    ```json
    { "id": "ex-2026-07-16-01", "source": "telegram:channelname",
      "quoted_message": "…", "scanner_flags": ["honeypot"],
      "matched_address": "…", "proposed": "2026-07-16T14:20:00Z",
      "status": "pending | confirmed | undocked" }
    ```

    Reply `undock <id>` / `confirm <id>` (or the CLI equivalents) — those
    remain the only terminal writes to `sources.json`. Proposals have no
    timeout: the penalty stays suspended until decided, and the adjacency
    counter has already incremented either way
  - either way, the source's **rug-adjacency counter** increments — phrasing
    cannot hide base rates, and the deterministic repeat-offender dock keys off
    this counter, not off intent

Classifier results are cached by raw-item hash + prompt version and deduped before
session launch. The initial cap is 20 uncached classifications/day. Exhaustion
cannot suppress a dock: remaining matches take the fail-closed `shill` path and
the run report raises an operator-visible capacity incident. Token usage and
cache hits are included in run telemetry.

Net effect: prompt injection can influence what the bot *says*, but against the
scoring system its ceiling is leniency for the channel that posted the message —
it can never create a dock, raise a score, or hide from the adjacency counter.

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
3. **Operator DM (last resort + always for auth + review)** — anything the
   ladder can't fix; every needs-headful-reauth condition (never automated, by
   design); every recovery-agent invocation (you should know it ran, even when
   it succeeded); and every **exoneration proposal** from a `warn` intent
   verdict (manual undock/confirm). All go through the chat bot's outbound DM
   path — not the broadcast router.

Recovery restores the *main agent's* flow; it never expands anyone's privileges —
the recovery agent is exactly as sandboxed as every other session (INV-S11).

## Outbox → router

- Agent writes proposals to `agent/outbox/<run-id>.json`; schema in
  `src/lib/outbox.ts`: `{ severity: "watch" | "notable" | "urgent", text: ≤ 280
  chars (narrative shifts: ≤ 3 short sentences), refs: [state paths],
  audit_claim: { type, subject, direction, horizon_hours, verification_rule } }`.
  The validator resolves the subject against host state and accepts only known
  host-owned rules compatible with the claim type/direction. Unauditable claims
  do not leave the machine
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
- Locking: see "Workspace locking" above — writer lock + per-job guard, chat
  reads lock-free

## Source files to inspect before editing (once implemented)

- `src/cli.ts` — entry point, job dispatch, locking
- `src/orchestrator/jobs.ts` — the job registry
- `src/orchestrator/run.ts` — collector orchestration + sdk session
- `src/orchestrator/outbox.ts` — validation, budget + urgent bypass, router sender
- `src/orchestrator/audit.ts` — outcome computation (incl. counterfactuals),
  ledger marking, calibration, source attribution
- `src/orchestrator/alpha-queue.ts` — digest-then-purge lifecycle
- `src/orchestrator/recover.ts` — recovery ladder: rollback, retry, recovery agent
- `src/orchestrator/sources.ts` — the sole `sources.json` writer: deterministic
  attribution, dock, audit scoring maths, operator undock

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
