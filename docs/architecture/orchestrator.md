---
description: Orchestrator module - job registry, cron cycles, Cursor CLI session management, outbox validation with urgent bypass, alpha-queue lifecycle, performance-audit job.
scope: module
status: active
last_verified: 2026-07-19
read_when:
  - Editing src/orchestrator/, src/cli.ts, src/harness/, or ops/ schedules.
  - Changing how agent sessions are created, how outbox items are sent, how the alpha queue is purged, or how audits score decisions and sources.
---

# Orchestrator

## Purpose

The only trusted, network-capable, always-scheduled component. It decides *when*
things happen, *what inputs* the runtime agent gets, and *what leaves the machine*.
It contains no trading logic and no LLM prompting beyond the fixed job prompts.

## Implementation status (2026-07-18)

Offline-green journalled `runJob` path exists with archive-authoritative
transactions (ADR 006): pre-session inbox archive, post-run verifier
(fail-closed before seal/purge/egress), validated alpha digest purge, atomic
broadcast budget ledger, HMAC delivery, `outcomes-settle` + audit hooks with
live DexScreener→GeckoTerminal bar providers (empty ⇒ pending), proposal gate
evidence via archived dossier then allowlisted live refetch (skipped under
dry-collect), and operator `undock`/`confirm`. `list-scan` is the primary live
X collector job. `chart-sweep` and `narrative-scan` collectors are live
(collectors.md). Periodic Git remains backup-only. Deployed runtime carries
`~/.trenchcoat/runtime/deployment.json` (written by `ops/install-launchd.sh`).

## Jobs (v1 registry)

| Job | Cadence (initial) | Collectors | Agent output |
|---|---|---|---|
| `watchlist-scan` | every 2h | active watchlist market + security snapshots, optional bounded X/Farcaster token search; **host-pre skip** when empty watchlist | watchlist evidence review |
| `list-scan` | ~every 4h (uniform jitter 3h15m–4h45m via `ops/run-job-jittered.sh`) | FYP + two operator X lists + managed list *(live)*; host `list-scan-alpha-manifest` (pending `alpha-queue/` paths); coingecko / dexscreener / new-pool *(planned)* | trends, discovery candidates, bot `x-engagement.json` likes/follows (default ≤2 likes/10m); **digests alpha queue** via `alpha-digest.json` |
| `farcaster-scan` | ~every 4h (same jitter gate as list-scan) | Neynar for-you + optional channels + following; one trending fallback when for-you has no live evidence *(live when `farcaster.enabled`)* | trends/discovery from any usable FC feed; likes only on live for-you cast hashes (`fc-engagement.json`, ≤2 likes/10m) |
| `source-list-review` | daily + after sealed audit | lagged source-score epoch + managed-list membership | **no agent** — host-only promote/demote, then X sync (source-lifecycle.md) |
| `fc-source-review` | daily | lagged `fc_*` source-score + follow-graph sync | **no agent** — promote/demote then Neynar follow/unfollow |
| `narrative-scan` | every 6h | sealed complete list-scan/FC archive reuse + CoinGecko trending with Dex/Gecko fallback (live≤6h / stale≤24h; **degraded** when market-blind; skip if no usable evidence) | agent proposes `reports/<run-id>/narrative-proposals.jsonl`; host merges into the integrity-protected `state/narratives/log.jsonl`, bridges new/peaking narratives to bounded research queue candidates, then prunes entries older than `narratives.retention_days` (default 14) and reconciles `INDEX.md`; new slug **or stage-change** → outbox (`narrative-emergence` / `narrative-fade` / `rotation`; same-stage re-sightings host-rejected; rotation host-rejected when market-blind; single-platform rotation/sentiment-collapse capped at `watch` and labeled `X-only` / `Farcaster-only`) |
| `research` | on queue (research-queue.md), daily cap from config; also `tc research` / Telegram confirm | market data + security + bounded X + Farcaster token search (+ optional Tavily web search on operator path) | verdict (track / ignore / revisit) + research file with sentiment/popularity section, sources cited |
| `chart-sweep` | every 1h | GeckoTerminal 15m → 1h/4h aggregation, indicators, PNG manifests; **host-pre skip** when no active watchlist | early-move flags (skipped when no charts) |
| `review` | daily 07:00 | sealed report manifests (path-only) + pending alpha + watchlist/macro + **host health snapshot** + skip-ledger counts; scope also from empty queues / silent wallets / stale FC / recurring skips | distillation `agent.md`, bounded `decision-proposals.json`, `alpha-digest.json`, durable `state/research/*.md`; host reconciles INDEX |
| `audit` | weekly | outcome data: returns/liquidity since each past decision | scorecard update, **source-score update**, audit report |
| `outcomes-settle` | frequent / before audit | mature source-call + wallet-buy observations | **no agent** — resumable settlement writers |
| `wallet-discovery` | every 6h | watchlist token identities → Helius/Infura/Robinhood early buyers | host stages `candidate` wallets + cursors; evidence-only agent reads frozen snapshot |
| `wallet-scan-solana` | every 5m | Helius finalized wallet actions | host archives buy outcomes; evidence-only agent reads frozen snapshot |
| `wallet-scan-evm` | every 15m | Infura (eth/base) + throttled Robinhood public RPC | host archives buy outcomes; evidence-only agent reads frozen snapshot |
| `wallet-review` | daily / after scans | lagged settled buy outcomes + bounded voter | **no agent** — promote/drop + `wallet.lifecycle` router events |
| `harness-improve` | weekly (off by default) | sealed scorecard epochs only | **no agent write to prod** — confined worktree + tests + optional `gh pr create` (ADR 005); never merges, never starts canary |

Cadences live in `ops/` templates, not code; tune freely. Host-gated jobs
(`chart-sweep`, `watchlist-scan`, `research`, wallet evidence jobs, and
calendar `review`) run through `ops/run-precheck.sh` before the lock: a
read-only `tc precheck <job>` exits 10 on empty prerequisites so launchd
avoids a full run; `runJob` re-checks under lock and appends
`archive/skips/<job>.jsonl` (no run journal / inbox / reports). Preconditions
still apply under `--dry-collect`; missing `agent/state/` fails closed as
`not-initialized`. When a collector runs but sets `skipAgent` (degraded /
unusable evidence), the run is journaled and sealed as `collector-skip` without
an `agent.md` stub. `list-scan` and
`farcaster-scan` are special: launchd polls every 15m and
`ops/run-job-jittered.sh` (deployed as `~/.trenchcoat/bin/run-<job>`) gates real
runs to a uniform delay in [3h15m, 4h45m] after each success — anti-patterning
for the social burners. Cron is the only trigger — no daemon (the telegram
operator listener and `tc listen channels` alpha poller excepted, see
collectors.md), no human. The CLI also accepts on-demand
runs (operator or chat service).

Decision weighting is the bot's job, not ours: skills instruct it to blend
technicals with attention/sentiment/narrative evidence, weighted by each source's
score from `state/sources.json`. The orchestrator just guarantees those inputs
exist and are fresh.

## Run loop

Run collectors → assemble `agent/inbox/<run-id>/` **and copy it into the
host-side archive** (`~/.trenchcoat/archive/`, snapshot-archive.md — the
tamper-proof record scoring and audits read from) → one-shot agent session →
post-run integrity checks (host-only files unchanged, decision cards
well-formed, INV-S9 cross-reference) → host phases (proposals, engagement,
wallet jobs, **narrative bridge then narrative-log prune** on `narrative-scan`) → write **as-of
bundles** for any new decisions (snapshot-archive.md) → create/finalise pending
ledger actions → validate and stage outbox deliveries → commit state + reports
(INV-S8) → purge only durably digested alpha items → deliver staged outbox
items → atomically mark the run complete → surface report. Delivery failures
remain queued and do not uncommit an otherwise valid run.

Post-run checks distinguish two write phases: agent-phase (host-only files —
`sources.json`, `source-lifecycle.json`, `ledger.json`, `research-queue.json`,
`scorecard.json`, `wallets.json` — must be byte-identical before vs after the session) and
orchestrator-phase (the run loop's own deterministic writes after the checks
pass). INV-S7/S10/S21 are assertions about the agent phase; orchestrator-phase
writes are the designed path for scoring, FYP candidacy registration, and
source-list review.

For `narrative-scan`, `state/narratives/log.jsonl` is integrity-protected, so the
agent cannot write it: it proposes updates in
`reports/<run-id>/narrative-proposals.jsonl`, and after the session passes
integrity the host `mergeNarrativeProposals` schema-validates and merges those
proposals into the log. The host snapshots the merged log against the
pre-session baseline; new slugs and transitions into `peaking` are the only bridge
triggers. The bridge resolves a maximum of 10 ticker candidates, records ambiguous
shortlists in `research-queue.json`, and never writes watchlist, ledger, or
decision state.

## Workspace locking

One writer at a time, two levels:

- **Workspace writer lock** (`agent/.lock` + `.lock.owner`, O_EXCL PID-file via
  `src/lib/lock.ts`) — acquired first by `runJob`. `tc run` exits 3 if held.
  Target: also held by chat research sub-agents and recovery for their full
  duration (INV-S15 PARTIAL until those paths share the lock).
- **Job-level guard** — the CLI additionally refuses to start a job whose
  previous run is still live, so a slow job can't stack on itself.

Chat *reads* (the conversational session answering from INDEX/reports) take no
lock — they tolerate a mid-run snapshot of state. Anything that writes state
must go through the writer lock (INV-S15).

## Run idempotency and crash consistency

Every run has an **archive-authoritative journal**
(`~/.trenchcoat/archive/transactions/<run_id>.json`, ADR 006) with monotonic
phases and hashes for collector archive, checked agent diff, decision bundles,
host state mutation, archive seal, alpha purge, outbox delivery, and completion.
Journals carry `status: running | complete | failed`. Incomplete (`running`)
runs are resume candidates; `failed` is terminal (not auto-resumed —
`findIncompleteRuns` skips it). Mid-flight errors call `markRunFailed` with a
sanitised code/message before exit 2. Phases are fsynced and atomically renamed.
Recovery resumes the first incomplete phase; it does not replay earlier side
effects. Periodic Git (`tc backup`) is backup-only and never gates completion.

**Deployment manifest** — `ops/install-launchd.sh` stages a runtime, writes
schema-2 `deployment.json` (commit, `sourceDirty`, deterministic `sourceHash`,
config schema, cli/config module hashes, package version), validates config
against the staged binary, then swaps `~/.trenchcoat/runtime`. Dirty trees are
refused unless `--allow-dirty`. `tc status` flags a missing/stale manifest,
schema mismatch, or dirty provenance.

**Status / health snapshot** — `src/orchestrator/health.ts` builds one read-only
snapshot used by `tc status` (default text + `--json`), Telegram `/status`, and
daily `review` inbox inputs. It covers lock / incomplete / abandoned runs
(`findIncompleteRunRefs`), last success|failure|skip ages for key jobs,
`archive/skips/*.jsonl` reason counts, research actionable vs ambiguous depth,
watchlist/wallet counts, X pending + bot-health escalation, FC stale
streak/fallback from recent sealed receipts, router ingress backlog via
`snapshotBroadcastPipeline`, and deployment provenance / schema compatibility.
FOMO is a separate parallel section and cannot declare legacy arms healthy.
Health warnings are non-fatal; preflight/config/runtime failures still exit
non-zero. Review keeps empty queues, silent wallets, stale FC, and recurring
skips in scope even without agent report directories (cadence remains once-daily
07:00).

**INDEX reconcile** — host `reconcileIndex` rewrites `state/INDEX.md` (integrity-
protected) after accepted decision proposals (watchlist mutations), after
`narrative-scan` prune, after accepted `state/research/` changes on `review`,
and after `tc watchlist remove`. Tokens rollup includes
watchlist entries, decided/removed subjects from `decisions.md`, and
narrative-linked tickers from `narratives/log.jsonl`. Agents do not own this
file. Successful reconciles archive `index-reconcile-receipt.json` under
`archive/runs/<run-id>/` (mirrored to `agent/reports/<run-id>/`) with before/after
INDEX hashes and source timestamps. Health/status narrative age must come from
sealed complete `narrative-scan` journals (`resolveSealedNarrativeFreshness`),
never from human-readable dates inside `INDEX.md`.

**Workspace retention** — after delivery, each run age-prunes `agent/inbox/` and
`agent/reports/chat/` per `config.retention` (`retention.ts`). Never prunes
`archive/`.

Idempotency keys are structural:

- decision bundle and ledger position: `decision_id`
- alpha knowledge/digest/purge: provenance + message id
- source call event: raw-item hash + parser version
- outbox delivery: run id + validated item hash, passed to the router as its
  required idempotency key
- archive seal: side-effect hash recorded before purge/egress

Host records prepared before a failed archive seal remain unsealed and
ineligible for audits. Seal failure retries while the lock is held; after
bounded failure or hash conflict the run quarantines
(`archive/quarantine/<run-id>/`), and no alpha purge or external delivery
occurs. A crash after seal resumes purge/delivery from their keys. The
completed marker is written only after seal and all non-delivery integrity
phases pass. Pending router deliveries are allowed and visible.

Delivery uses a stable idempotency key honoured by the in-repo router
(`src/router/**`, ADR 001 / INV-B5): duplicates are safe; payload conflicts 409.

## Alpha-queue lifecycle

The telegram listener appends continuously; digestion is batch:

1. Alpha-digesting jobs (`list-scan`, `review`) include the queue contents in scope
2. The agent records anything useful in the knowledge store (with provenance) and
   writes `reports/<run-id>/alpha-digest.json` listing the message ids it processed
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
Lessons feed back into skills only via a developer edit or the host-owned
Harness Improvement Loop (ADR 005) — the runtime bot does not rewrite its own
instructions.

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
  response hard-failing a candidate (honeypot, live mint authority, etc. —
  not `low-lp-lock` alone; security-gate.md). Every attributed source takes a
  severe cumulative penalty in the same run; repeat offenders are flagged for
  operator removal in the next report.
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

## Failure recovery

Recovery is deterministic and privilege-preserving (ADR 006 / INV-S11):

1. **Journal resume (host-side, no LLM)** — default path: listener death →
   launchd keepalive; incomplete run → resume first unfinished phase from
   `archive/transactions/<run-id>.json` without replaying sealed side effects;
   hash conflict → quarantine under `archive/quarantine/` and refuse
   auto-resume; router down → staged outbox waits for the next cycle. Alpha
   queue is never purged until digest + seal succeed (INV-Q1).
2. **Operator DM (auth + review)** — needs-headful-reauth (never automated) and
   every **exoneration proposal** from a `warn` intent verdict (manual
   undock/confirm). Via the chat bot's outbound DM path — not the broadcast
   router.

A `recover` job/skill remains registered for optional operator-assisted
diagnosis but is **not** on the automatic ladder and must not expand
privileges or rewrite host-only state (INV-S2/S7/S10/S11).

## Outbox → router

Two different “outbox” surfaces — do not conflate them:

| Path | Contents | Module |
|---|---|---|
| `agent/outbox/<run-id>.json` | Agent **BroadcastItem** proposals (schema: `BroadcastItemSchema` in `src/contracts/schemas.ts`) | Validated by `ingestOutbox` → `validateBroadcastItem` (no Telegram count limit). Wrong envelopes (`broadcasts`, bare `text`) are rejected with an auditable receipt, never silently dropped. Wired in the run loop after seal (`events-staged`) |
| `agent/reports/<run-id>/chat-summary.json` | Optional agent chat-recall context (`ChatSummaryFileSchema`; `itemIds` may be empty) | `validateAndPromoteChatReport` after `ingestOutbox` for list/narrative/fc/review/research: host always renders `reports/chat/<run-id>.md` from trusted facts; appends accepted context when present. Missing/invalid proposals are non-fatal (`proposalReason`); canary still blocks promotion |
| `~/.trenchcoat/archive/router-outbox/<runId>/` | Durable **RouterEvent** files staged for HMAC POST | `src/lib/outbox.ts` (`Outbox.stage`). Used today by wallet-review / wallet-seed |

There is no `src/orchestrator/outbox.ts`. Agent proposals are not the same type as
staged router events.

- Validator resolves the subject against host state and accepts only known
  host-owned rules compatible with the claim type/direction (`isKnownVerificationRule`).
  Unauditable claims do not leave the machine
- Discord budget only: `watch`/`notable` consume `broadcast.daily_budget` (default 5)
  when attaching `channels.discord` in `renderChannelPayloads`. **`urgent` bypasses
  that Discord daily budget** but still hits `urgent_ceiling` (default 10/day) as a
  Discord failsafe (INV-B4). Telegram is never count-limited after schema validation.
  Separate: `broadcast.discord_distiller.daily_cap` and
  `broadcast.telegram_overview.daily_cap` cap LLM sessions (shared used counter under
  `archive/broadcast-budget/discord-distill-<day>.json`), not Discord message count
- Over Discord budget: omit `channels.discord` (router skips Discord; Telegram still
  sends). Receipted as `budget-skipped`, never silently dropped
- Host stages validated items, then `renderChannelPayloads` attaches per-destination
  text (`channels.telegram` always; `channels.discord` when Discord budget allows)
  before HMAC-POST to the long-lived router (`com.trenchcoat.router` / `tc router serve`;
  `TRENCHCOAT_ROUTER_*` — see [router.md](router.md)). Telegram gets a fail-closed
  landscape overview (`distill-session.ts` / `telegram_overview`) when enabled —
  longer chat-style report that may restate current narrative heat; else short
  `event.text`. Discord gets a fail-closed new-things-only distiller when
  `broadcast.discord_distiller.enabled` (else short broadcast text). Bare intake
  hosts default to `/v1/events`; loopback HTTP is allowed. Severity `lifecycle`
  (wallet add/drop) skips Discord market budget and is never distilled
- Send failures never fail the run; durable fanout retries with dead-letter visibility

## Design patterns

- **One shot per job**: Cursor CLI headless
  `agent -p --trust --sandbox enabled --workspace <agent/> --model composer-2.5`.
  Auth is the operator's `agent login` session (see [CLI install](https://cursor.com/docs/cli/installation)).
  `--resume <chatId>` only where follow-up turns are needed (chat service).
- **Two failure kinds, two exit codes**: CLI missing/not logged in = run never
  started (env problem, exit 1); non-zero CLI exit = run failed mid-flight
  (inspect transcript, exit 2). Never conflate them.
- **Explicit workspace**: always pass `--workspace` to the agent root; do not
  inherit ambient IDE settings from the host repo.
- Jobs are data (a typed registry); the run loop is one function. New flow = job
  entry + skill in the workspace, no new orchestration code.

## Key abstractions

- `Job` — name, cadence hint, collector list, prompt template, output contract,
  `digestsAlphaQueue` flag
- `RunContext` — run id, timestamps, inbox path, job name; threaded through
  collectors and archived with the report
- Outbox → router staging — validated items + idempotency keys into `src/router/`
- Locking: see "Workspace locking" above — writer lock + per-job guard, chat
  reads lock-free

## Source files to inspect before editing

- `src/cli.ts` — entry point, job dispatch, locking
- `src/orchestrator/jobs.ts` — the job registry
- `src/orchestrator/run.ts` — collector orchestration + Cursor CLI session
- `src/orchestrator/journal.ts` / `journal-store.ts` — run journal phases +
  `running|complete|failed` status
- `src/orchestrator/index-reconcile.ts` — host `state/INDEX.md` rewrite +
  `index-reconcile-receipt.json` (before/after hash, source timestamps,
  sealed narrative freshness note)
- `src/orchestrator/chart-collect.ts` / `narrative-collect.ts` — collector jobs
- `src/lib/deployment.ts` — runtime `deployment.json` manifest
- `src/orchestrator/broadcast.ts` — Discord-only daily/urgent budget maths + known verification rules
- `src/orchestrator/outbox-ingest.ts` — validate agent broadcast proposals and stage (no count limit)
- `src/orchestrator/channel-render.ts` — attach Telegram/Discord payloads; Discord budget reserve
- `src/orchestrator/chat-report.ts` — host-render `reports/chat/<run-id>.md` from trusted run facts after `ingestOutbox` (`list-scan`, `narrative-scan`, `farcaster-scan`, `review`, `research`); optional `chat-summary.json`/`.md` context appended when valid
- `src/orchestrator/narrative-log.ts` — `pruneNarrativeLog`: drop malformed lines + purge `lastSeen` older than `narratives.retention_days` (default 14)
- `src/orchestrator/router.ts` — BroadcastItem validation + HMAC `deliverRouterEvent`
- `src/lib/outbox.ts` — durable RouterEvent staging under archive
- `src/orchestrator/proposals.ts` — host-validated decision proposals (INV-S23)
- `src/orchestrator/gate-evidence.ts` — archive-then-live security gate receipts
- `src/orchestrator/market-bars.ts` — live DexScreener/GeckoTerminal BarProviders
- `src/orchestrator/outcomes-settle.ts` — mature source-call + wallet-buy settlement
- `src/orchestrator/audit.ts` — outcome computation (incl. counterfactuals),
  ledger marking, calibration, source attribution
- `src/orchestrator/recovery.ts` — resume/discard-inbox stub (full recovery ladder open)
- `src/orchestrator/sources.ts` — archive source-call outcome loader (host `sources.json` writer still open)
- `src/orchestrator/wallet-*.ts` — host-only wallet discovery/scan/review/seed
- `src/harness/**` — harness-improve schedule / confine / evaluate / canary / PR

## Gotchas and security-sensitive boundaries

- Router credentials and Telegram credentials live in the
  orchestrator/chat env only — never under `agent/` (INV-I3). Cursor auth is the
  operator's CLI login (`agent login`), not a key filed under `agent/`.
- Broadcast text is downstream of untrusted tweets/alpha messages: the router
  sender transmits the schema-checked `text` field only, never raw snapshot
  content (INV-B2)
- The Discord urgent bypass is the obvious abuse vector for a prompt-injected agent —
  that's what the Discord failsafe ceiling and the audit's broadcast-precision-per-severity
  metric exist for; do not remove either (INV-B4). Telegram stays uncapped after validation.
- Purge only what the digest manifest lists — a crash between digest and purge must
  not lose undigested messages (INV-Q1)
- Log `run.id` and `agent.agentId` immediately after session start, before waiting —
  the only investigation handle if a run hangs
- Prompt templates never interpolate scraped text — reference inbox files by path
  (INV-P2)
- Audit outcome maths shares the rate-limit gate; a weekly audit over a large
  watchlist must chunk its GeckoTerminal calls (INV-R1)
