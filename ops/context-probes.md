# Context Probes

Golden questions a fresh agent should answer from the context graph alone.
Run during context maintenance; treat failures as selection bugs, not knowledge bugs.
See `~/.cursor/skills/context-engineering/refs/context-probes.md`.

| ID | Type | Question | Expected pointer or fact | Last result | Date |
|----|------|----------|--------------------------|-------------|------|
| P1 | recall | Which broadcast severity bypasses the daily budget, and what still constrains it? | `urgent` bypasses; schema check + failsafe ceiling (default 10/day, hitting it = incident) → docs/architecture/orchestrator.md "Outbox → router", INV-B4 | pass | 2026-07-18 |
| P2 | recall | Who is allowed to write `state/sources.json`, and why is that restricted? | Only deterministic host code: audit scoring maths, rug-shill dock, operator undock/confirm, neutral auto-registration; never a model session, so shilled content can't vouch for its own source → INV-S7/S12, agent-workspace.md | pass | 2026-07-18 |
| P5 | recall | A candidate surfaces on a chain we don't support — what happens, and how do we add the chain? | Fail-closed: no registry entry or no scanner → never `tracking`, rejection logged for audit; adding = registry entry + provider id verification, no RPC (docs/architecture/chains.md) | pass | 2026-07-18 |
| P6 | recall | Why can't the audit accidentally grade a decision with hindsight? | The as-of bundle freezes evidence; execution/outcomes use immutable post-event observations; a sealed epoch freezes cohort/versions; source scores lag one cycle → INV-S14/S18, snapshot-archive.md | pass | 2026-07-18 |
| P3 | artifact | Where does Farcaster (Neynar) live, and what does ops enablement still need? | Implemented under `src/collectors/farcaster/` with `farcaster-scan` / `fc-source-review` (ADR 007); enable via `farcaster.enabled` + Neynar/signer auth → collectors.md, TECHNICAL-SPEC, knowledge/neynar.md | pass | 2026-07-18 |
| P4 | continuation | What is the offline vs live acceptance status of the implementation? | Offline `pnpm test:all` green; Phase 0–3 audit roadmap DONE (`ops/ROADMAP-2026-07-18-audit.md`); live X follow verified 2026-07-18; remaining live E2E still operator/credential gated in ops/LIVE-E2E-BLOCKERS.md; many INVARIANTS still PARTIAL (INV-I5 container smoke still open) | pass | 2026-07-18 |
| P24 | continuation | What is next after Phase 3 of the 2026-07-18 audit roadmap? | Phase 3 DONE (3A host prechecks + skip ledger, 3B market-blind narrative attention, 3C follow dedupe + live follow). Further work is ops hardening / remaining PARTIAL invariants — not a numbered Phase 4 in that roadmap → ops/ROADMAP-2026-07-18-audit.md | pass | 2026-07-18 |
| P7 | recall | How does trenchcoat authenticate Cursor agent job sessions? | Cursor CLI login (`agent login` / `agent status`), headless `agent -p --trust --workspace agent/`; not `@cursor/sdk` / required `CURSOR_API_KEY` → ADR 003, docs/knowledge/cursor-cli.md | pass | 2026-07-18 |
| P8 | recall | What must stay true when merging parallel feature worktrees? | Integration owner exclusively merges `package.json`, `src/contracts/**`, `src/orchestrator/run.ts`, `src/orchestrator/collect.ts`, `docs/INVARIANTS.md`; cherry-pick non-overlapping files and reconcile duplicate APIs before declaring green → docs/development.md | pass | 2026-07-18 |
| P9 | recall | Who may add or remove members of the bot-managed X list, and from what evidence? | Only host lifecycle code after lagged settled direct bullish raw-CA outcomes; FYP text/model/engagement cannot promote; operator lists are immutable inputs → ADR 004, source-lifecycle.md, INV-S21 (PARTIAL until sealed outcomes feed review) | pass | 2026-07-18 |
| P10 | recall | Which X network mutations are allowed, and what must match before any membership change? | Only GraphQL `CreateList`/`ListAddMember`/`ListRemoveMember` in the host synchronizer; target list id must equal persisted managed list id; scrapers stay read-only → INV-R2 (PARTIAL — allowlists ENFORCED; like throttle config-default), knowledge/x-playwright.md | pass | 2026-07-18 |
| P11 | recall | Where does the X burner Playwright profile live, and is it `browser-profile`? | `~/.trenchcoat/twitter-profile/` only; never under `agent/` or the repo; name is not `browser-profile` → knowledge/x-playwright.md, collectors.md | pass | 2026-07-18 |
| P12 | recall | Can the agent like FYP posts, and does that promote managed-list membership? | Agent owns like/follow choices; likes must target same-run FYP post ids; proposal-time subscription dedupe (`already_liked` / `already_following` / `not_following` / `pending_duplicate`); default ≤2 likes / 10 min (INV-S22 PARTIAL); engagement never writes managed-list or source scores → INV-S22, source-lifecycle.md, x-playwright.md | pass | 2026-07-18 |
| P13 | recall | Can the scheduled `harness-improve` job merge a PR or start a live canary? What may candidate canaries never do externally? | Scheduled job may open a PR only — never self-merges, never starts canary, must not call `evaluateHypothesis` (that compares sealed epochs, not the candidate patch); canaries block candidate external effects → ADR 005, architecture/harness-improvement.md, INV-S24/S25 | pass | 2026-07-18 |
| P14 | recall | Who may write `state/wallets.json`, and how do wallet add/drop events relate to the market broadcast budget? | Host-only (discovery/scan/review/seed); evidence-only `wallet-evidence` agent may write advisory `wallet-evidence.md` only — never state/scores/cursors/lifecycle; each applied transition emits one `wallet.lifecycle` router event on a lane that does not consume market broadcast budget → smart-wallets.md, ADR 002, INV-S19/S20 | pass | 2026-07-18 |
| P15 | recall | What are the two “outbox” surfaces, and which module stages router delivery? | `agent/outbox/<run-id>.json` = BroadcastItem proposals; host `ingestOutbox` → `archive/router-outbox/` via `src/lib/outbox.ts`, then `renderChannelPayloads` (optional `channels`) then `deliverStagedOutbox`. No `src/orchestrator/outbox.ts`. HMAC in `src/orchestrator/router.ts` → orchestrator.md "Outbox → router", INV-B2 | pass | 2026-07-18 |
| P16 | recall | When does `narrative-scan` fire a broadcast, and who owns/prunes the rolling log? | `state/narratives/log.jsonl` is host-owned/integrity-protected; the agent proposes updates (new slugs, `lastSeen`/`stage`) in `reports/<run-id>/narrative-proposals.jsonl` and one `narrative-emergence`/`rotation` in `outbox/<run-id>.json` per newly appended slug only; host `mergeNarrativeProposals` schema-merges proposals, then `pruneNarrativeLog` drops malformed + `lastSeen` older than `narratives.retention_days` (default 14) after the session → agent-workspace.md, orchestrator.md, CONFIG.md schema 7 | pass | 2026-07-18 |
| P17 | recall | Is Neynar/Farcaster phase-2 or shipped, and which ADR binds it? | Shipped host path (`farcaster.enabled`, `farcaster-scan` / `fc-source-review`); ADR 007 — not phase 2 → TECHNICAL-SPEC §15, source-lifecycle.md | pass | 2026-07-18 |
| P18 | recall | What is authoritative completed-run durability — per-run git commit or archive journal? | Archive journal (`archive/transactions/`); Git is backup-only (`tc backup`) and never gates completion → ADR 006, orchestrator.md, INV-S8 | pass | 2026-07-18 |
| P19 | recall | Must the router process be running for broadcasts to reach Telegram/Discord, and how is it scheduled? | Yes — jobs only stage + HMAC-POST; fanout is the KeepAlive `com.trenchcoat.router` (`tc router serve`) via `install-launchd.sh`. Needs `TRENCHCOAT_ROUTER_*` + destination env (`TELEGRAM_ROUTER_BOT_TOKEN`/`CHAT_ID` and/or `DISCORD_WEBHOOK_URL`). Runtime install rebuilds `better-sqlite3`. Bare intake URL defaults to `/v1/events`; loopback HTTP allowed → router.md, runbook.md | pass | 2026-07-18 |
| P20 | recall | What text does Telegram vs Discord get for a market broadcast, and where does the Discord rewrite run? | Telegram: promoted `reports/chat/<run-id>.md` as-is (else short `event.text`). Discord: host fail-closed distiller (`distill-session.ts` / `renderChannelPayloads`) — new-things-only, no provenance handles, ≤3 tickers, no status-quo filler; else `event.text`. Distiller is orchestrator-side, never inside the router. `wallet.lifecycle` never distilled → router.md, INV-B2 | pass | 2026-07-18 |
| P21 | recall | When does narrative-scan enqueue research, and can resolution put a token on the watchlist? | Host `bridgeNarrativeTickers` after integrity: new slug or transition to `peaking`; trigger `narrative`; ambiguous stays ambiguous; resolution never writes watchlist — only a later dossier-bound gate-passing research proposal can track → research-queue.md, token-resolution.md, INV-S9/S10 | pass | 2026-07-18 |
| P25 | recall | Does scheduled `research` still run when the queue is empty? | No — dequeue before `createRunId`; empty / pending-not-due / daily-cap appends `archive/skips/research.jsonl` and returns `runId: "none"`; `tc precheck` is lock-free peek only; due entries stay in-file as `researching`; cron defers `preArchiveRun` until after `runResearchPasses` → research-queue.md, orchestrator.md | pass | 2026-07-18 |
| P23 | recall | Where does narrative-scan get market attention, and what happens when CoinGecko categories are missing? | `fetchMarketAttentionForNarrative` in `providers.ts` (retry + Dex/Gecko fallback) — not `aggregate.ts`/`market-bars.ts`; missing categories → `marketBlind` + `degraded`; host rejects rotation broadcasts → market-risk.md, collectors.md, INV-R3 | pass | 2026-07-18 |
| P26 | recall | What does `tc precheck <job>` do vs a host precondition skip inside `runJob`? | Precheck is lock-free best-effort (exit 10 = skip); `runJob` re-checks under lock and appends `archive/skips/<job>.jsonl` with `runId: none` (no journal). Host-gated: chart/watchlist/research/wallets/review → orchestrator.md, development.md | pass | 2026-07-18 |

## Failure log

Record each failed run and the graph fix that resolved it, so recurring breakage
patterns become visible.

- 2026-07-16 P8 fail: expected merge ownership lived only in this table. Fix: added
  `docs/development.md` and linked it from `docs/README.md`.
- 2026-07-16 P4 soft-fail: expected answer claimed container isolation smoke passes;
  graph only had INV-I5 PARTIAL. Fix: narrowed expected pointer to match LIVE-E2E
  blockers + invariant status.
- 2026-07-16 maintenance: INV-R2 demoted ENFORCED→PARTIAL (like throttle
  config-default); added P13/P14 for harness + wallet lifecycle coverage.
- 2026-07-17 session-learning: dual-outbox path drift (`src/orchestrator/outbox.ts`
  did not exist) caused wasted search; fixed orchestrator.md and added P15.
  Documented chat idle clock injection + harness schedule ≠ `evaluateHypothesis`.
- 2026-07-17 session-learning (narrative broadcasts): silent router since launch
  was missing skill + outbox prompt gate for `narrative-scan` + empty
  `state/narratives/`; rolling `log.jsonl` + host 14d prune landed (schema 7).
  Fixed stale P15 “ingest unwired”; added P16; aligned TECHNICAL-SPEC with
  new-slug-only broadcast model. Live `~/.trenchcoat/config.json` may still be
  schema 6 on disk — `loadConfig` migrates in memory via `migrateConfigToV7`.
- 2026-07-17 context-maintenance: indexes still called Neynar “phase 2” and
  treated per-run git as INV-S8; INV-A1 STRUCTURAL falsified by Farcaster
  `viem` KeyGateway signing. Fixed TECHNICAL-SPEC/ARCHITECTURE/orchestrator,
  demoted INV-A1→PARTIAL (no trades; FC custody exception), GAP→PARTIAL for
  INV-S4/B1, added P17/P18. Probe suite 18/18 pass.
- 2026-07-18 session-learning (Phase 2 live): future-dated FC casts must expire
  (not clamp to live); Playwright tweet parse must avoid tsx `__name` in
  `evaluateAll` (`new Function`); `~/.trenchcoat/agent` skills do not auto-sync
  from repo; x-bot-health resets on any verified receipt in a mixed batch.
  Updated LIVE-E2E-BLOCKERS, chat-agent skill-sync note, P4/P21.
- 2026-07-18 session-learning: broadcasts were silent because (1) no KeepAlive
  router launchd unit, (2) bare `TRENCHCOAT_ROUTER_URL` signed `/v1/events` but
  POSTed `/`, (3) loopback HTTP rejected until validateRouterUrl allowed it,
  (4) `--ignore-scripts` left `better-sqlite3` unbound in runtime. Fixed intake
  + installer rebuild + `com.trenchcoat.router`. Per-channel semantics landed
  (Telegram full report / Discord host distiller). Extended INV-B2; added P19/P20;
  refreshed P15. Telegram fanout still needs `TELEGRAM_ROUTER_CHAT_ID` in env.
- 2026-07-18 session-learning (Phase 1): macOS `SnapshotWriter` needs
  `realpathSync` on temp agent roots; `systemClock` is frozen (no spyOn);
  new `writeInbox` callers must update `tests/redteam/static.test.ts`; cron
  research defers `preArchiveRun` until after Tavily mid-pass. Documented in
  development.md + research-queue.md; added P24/P25; widened P8/P14 + INV-I4
  caller allowlist.
- 2026-07-18 session-learning (Phase 3): host skips use `archive/skips/` +
  `tc precheck` exit 10 (research dequeue stays under lock); narrative market
  attention is providers/narrative-collect not aggregate/market-bars; market-blind
  blocks rotation; X subscription dedupe + live follow; lint allowlists FC
  `viem` signer only; skip tests must assert empty dirs not absent
  `ensureArchive` dirs. Updated development.md, research-queue.md, market-risk.md,
  LIVE-E2E-BLOCKERS; P4/P12/P25 refreshed; P23/P24/P26 added.
- 2026-07-18 context-maintenance: ADR 002/004 stale notes + TECHNICAL-SPEC
  wallet-vote open question drained; token-resolution / snapshot-archive /
  audit-metrics marked cron disambiguation + resolution-log as designed-not-wired;
  INV-I4 caller allowlist + INV-R3/S22 citation nits; NOTES Phase 3C stale blocker
  removed; README Phase 0–3 status; P16 pruneNarrativeLog named in
  agent-workspace. Probe suite 26/26 pass. Always-on unchanged (~306 tokens).
