# Context Probes

Golden questions a fresh agent should answer from the context graph alone.
Run during context maintenance; treat failures as selection bugs, not knowledge bugs.
See `~/.cursor/skills/context-engineering/refs/context-probes.md`.

| ID | Type | Question | Expected pointer or fact | Last result | Date |
|----|------|----------|--------------------------|-------------|------|
| P1 | recall | Which broadcast severity bypasses the Discord daily budget, and what still constrains Discord sends? | Discord `urgent` bypasses `daily_budget`; schema check + Discord `urgent_ceiling` (default 10/day). Telegram has no daily count limit after validation. Over Discord budget omits `channels.discord` (router `skipped-discord-budget`) → orchestrator.md "Outbox → router", INV-B2/B4 | pass | 2026-07-18 |
| P2 | recall | Who is allowed to write `state/sources.json`, and why is that restricted? | Only deterministic host code: audit scoring maths, rug-shill dock, operator undock/confirm, neutral auto-registration; never a model session, so shilled content can't vouch for its own source → INV-S7/S12, agent-workspace.md | pass | 2026-07-18 |
| P5 | recall | A candidate surfaces on a chain we don't support — what happens, and how do we add the chain? | Fail-closed: no registry entry or no scanner → never `tracking`, rejection logged for audit; adding = registry entry + provider id verification, no RPC (docs/architecture/chains.md) | pass | 2026-07-18 |
| P6 | recall | Why can't the audit accidentally grade a decision with hindsight? | The as-of bundle freezes evidence; execution/outcomes use immutable post-event observations; a sealed epoch freezes cohort/versions; source scores lag one cycle → INV-S14/S18, snapshot-archive.md | pass | 2026-07-18 |
| P3 | artifact | Where does Farcaster (Neynar) live, and what does ops enablement still need? | Implemented under `src/collectors/farcaster/` with `farcaster-scan` / `fc-source-review` (ADR 007); enable via `farcaster.enabled` + Neynar/signer auth → collectors.md, TECHNICAL-SPEC, knowledge/neynar.md | pass | 2026-07-18 |
| P4 | continuation | What is the offline vs live acceptance status of the implementation? | Offline suites green; Phase 0–3 DONE (2026-07-18 audit response, `ops/NOTES.md` § Phase status); managed list + `--sync-env` + reversible X + TG **preview-first alpha** (33 channels live 2026-07-19) + live isolation write/network/injection operator-verified; residual = GramJS auth/CLI injection for preview-disabled channels + INV-I1 outside-read PARTIAL + INV-I5 container reference-only → `ops/LIVE-E2E-BLOCKERS.md` | pass | 2026-07-19 |
| P24 | continuation | What is next after Phase 3 of the 2026-07-18 audit roadmap? | Phase 3 DONE (3A host prechecks + skip ledger, 3B market-blind narrative attention, 3C follow dedupe + live follow). Further work is ops hardening / remaining PARTIAL invariants — not a numbered Phase 4; status in `ops/NOTES.md` + `ops/LIVE-E2E-BLOCKERS.md` | pass | 2026-07-19 |
| P27 | recall | Does the host Cursor sandbox block reads and writes outside `agent/` equally? | Writes outside are blocked (`--sandbox enabled` + `disableTmpWrite: true`); outside reads still succeed on current CLI — INV-I1 PARTIAL; never rely on tmpdir-only escape probes → knowledge/cursor-cli.md, agent-workspace.md, INV-I1 | pass | 2026-07-18 |
| P7 | recall | How does trenchcoat authenticate Cursor agent job sessions? | Cursor CLI login (`agent login` / `agent status`), headless `agent -p --trust --workspace agent/`; not `@cursor/sdk` / required `CURSOR_API_KEY` → ADR 003, docs/knowledge/cursor-cli.md | pass | 2026-07-18 |
| P8 | recall | What must stay true when merging parallel feature worktrees? | Integration owner exclusively merges `package.json`, `src/contracts/**`, `src/orchestrator/run.ts`, `src/orchestrator/collect.ts`, `docs/INVARIANTS.md`; cherry-pick non-overlapping files and reconcile duplicate APIs before declaring green → docs/development.md | pass | 2026-07-18 |
| P9 | recall | Who may add or remove members of the bot-managed X list, and from what evidence? | Only host lifecycle code after lagged settled direct bullish raw-CA outcomes; FYP text/model/engagement cannot promote; operator lists are immutable inputs → ADR 004, source-lifecycle.md, INV-S21 (PARTIAL until sealed outcomes feed review) | pass | 2026-07-18 |
| P10 | recall | Which X network mutations are allowed, and what must match before any membership change? | Only GraphQL `CreateList`/`ListAddMember`/`ListRemoveMember` in the host synchronizer; target list id must equal persisted managed list id; scrapers stay read-only → INV-R2 (PARTIAL — allowlists ENFORCED; like throttle config-default), knowledge/x-playwright.md | pass | 2026-07-18 |
| P11 | recall | Where does the X burner Playwright profile live, and is it `browser-profile`? | `~/.trenchcoat/twitter-profile/` only; never under `agent/` or the repo; name is not `browser-profile` → knowledge/x-playwright.md, collectors.md | pass | 2026-07-18 |
| P12 | recall | Can the agent like FYP posts, and does that promote managed-list membership? | Agent owns like/follow choices; likes must target same-run FYP post ids; proposal-time subscription dedupe (`already_liked` / `already_following` / `not_following` / `pending_duplicate`); default ≤2 likes / 10 min (INV-S22 PARTIAL); engagement never writes managed-list or source scores → INV-S22, source-lifecycle.md, x-playwright.md | pass | 2026-07-18 |
| P13 | recall | Can the scheduled `harness-improve` job merge a PR or start a live canary? What may candidate canaries never do externally? | Scheduled job may open a PR only — never self-merges, never starts canary, must not call `evaluateHypothesis` (that compares sealed epochs, not the candidate patch); canaries block candidate external effects → ADR 005, architecture/harness-improvement.md, INV-S24/S25 | pass | 2026-07-18 |
| P14 | recall | Who may write `state/wallets.json`, and how do wallet add/drop events relate to the Discord market budget? | Host-only (discovery/scan/review/seed); evidence-only `wallet-evidence` agent may write advisory `wallet-evidence.md` only — never state/scores/cursors/lifecycle; each applied transition emits one `wallet.lifecycle` router event on a lane that does not consume Discord `daily_budget`/`urgent_ceiling` → smart-wallets.md, ADR 002, INV-S19/S20 | pass | 2026-07-18 |
| P15 | recall | What are the two “outbox” surfaces, and which module stages router delivery? | `agent/outbox/<run-id>.json` = BroadcastItem proposals; host `ingestOutbox` validates/stages with no Telegram count limit → `archive/router-outbox/` via `src/lib/outbox.ts`; then `renderChannelPayloads` (Telegram always; Discord only if Discord budget allows) then `deliverStagedOutbox`. No `src/orchestrator/outbox.ts`. HMAC in `src/orchestrator/router.ts` → orchestrator.md "Outbox → router", INV-B2 | pass | 2026-07-18 |
| P16 | recall | When does `narrative-scan` fire a broadcast, and who owns/prunes the rolling log? | `state/narratives/log.jsonl` is host-owned/integrity-protected; the agent proposes updates (new slugs, `lastSeen`/`stage`) in `reports/<run-id>/narrative-proposals.jsonl` and one `narrative-emergence`/`rotation` in `outbox/<run-id>.json` per newly appended slug only; host `mergeNarrativeProposals` schema-merges proposals, then `pruneNarrativeLog` drops malformed + `lastSeen` older than `narratives.retention_days` (default 14) after the session → agent-workspace.md, orchestrator.md, CONFIG.md schema 7 | pass | 2026-07-18 |
| P17 | recall | Is Neynar/Farcaster phase-2 or shipped, and which ADR binds it? | Shipped host path (`farcaster.enabled`, `farcaster-scan` / `fc-source-review`); ADR 007 — not phase 2 → TECHNICAL-SPEC §15, source-lifecycle.md | pass | 2026-07-18 |
| P18 | recall | What is authoritative completed-run durability — per-run git commit or archive journal? | Archive journal (`archive/transactions/`); Git is backup-only (`tc backup`) and never gates completion → ADR 006, orchestrator.md, INV-S8 | pass | 2026-07-18 |
| P19 | recall | Must the router process be running for broadcasts to reach Telegram/Discord, and how is it scheduled? | Yes — jobs only stage + HMAC-POST; fanout is the KeepAlive `com.trenchcoat.router` (`tc router serve`) via `install-launchd.sh`. Needs `TRENCHCOAT_ROUTER_*` + destination env (`TELEGRAM_ROUTER_BOT_TOKEN`/`CHAT_ID` and/or `DISCORD_WEBHOOK_URL`). Runtime install rebuilds `better-sqlite3`. Bare intake URL defaults to `/v1/events`; loopback HTTP allowed → router.md, runbook.md | pass | 2026-07-18 |
| P20 | recall | What text does Telegram vs Discord get for a market broadcast, and where do the rewrites run? | Telegram: fail-closed landscape overview from promoted chat report when `broadcast.telegram_overview.enabled` (`distill-session.ts` / `renderChannelPayloads`) — longer chat-style, may restate current narrative heat, no host plumbing/paths/provenance handles, ≤8k; else short `event.text`; uncapped after validation. Discord: fail-closed distiller — new-things-only, no provenance handles, ≤3 tickers, no status-quo filler / unchanged-stage restatement; else `event.text`. Message count uses `broadcast.daily_budget`/`urgent_ceiling` (omit `channels.discord` when over → router `skipped-discord-budget`); `discord_distiller`/`telegram_overview` `daily_cap` share an LLM-session used counter. Distillers are orchestrator-side, never inside the router. `wallet.lifecycle` never distilled → router.md, INV-B2 | pass | 2026-07-19 |
| P21 | recall | When does narrative-scan enqueue research, and can resolution put a token on the watchlist? | Host `bridgeNarrativeTickers` after integrity: new slug or transition to `peaking`; trigger `narrative`; ambiguous stays ambiguous; resolution never writes watchlist — only a later dossier-bound gate-passing research proposal can track → research-queue.md, token-resolution.md, INV-S9/S10 | pass | 2026-07-18 |
| P25 | recall | Does scheduled `research` still run when the queue is empty? | No — dequeue before `createRunId`; empty / pending-not-due / daily-cap appends `archive/skips/research.jsonl` and returns `runId: "none"`; `tc precheck` is lock-free peek only; due entries stay in-file as `researching`; cron defers `preArchiveRun` until after `runResearchPasses` → research-queue.md, orchestrator.md | pass | 2026-07-18 |
| P23 | recall | Where does narrative-scan get market attention, and what happens when CoinGecko categories are missing? | `fetchMarketAttentionForNarrative` in `providers.ts` (retry + Dex/Gecko fallback) — not `aggregate.ts`/`market-bars.ts`; missing categories → `marketBlind` + `degraded`; host rejects rotation broadcasts → market-risk.md, collectors.md, INV-R3 | pass | 2026-07-18 |
| P26 | recall | What does `tc precheck <job>` do vs a host precondition skip inside `runJob`? | Precheck is lock-free best-effort (exit 10 = skip); `runJob` re-checks under lock and appends `archive/skips/<job>.jsonl` with `runId: none` (no journal). Host-gated: chart/watchlist/research/wallets/review → orchestrator.md, development.md | pass | 2026-07-18 |
| P28 | recall | How does Discord interactive research differ from Discord market broadcasts? | Two surfaces: router webhook `DISCORD_WEBHOOK_URL` (budgeted broadcast fanout) vs Gateway `DISCORD_RESEARCH_BOT_TOKEN` + `tc listen discord` (isolated `~/.trenchcoat/discord/`, ✅ start reaction then final-only text replies, INV-D1, ADR 010) → discord-research.md, knowledge/discord.md | pass | 2026-07-19 |
| P29 | recall | Can Fomo X-source classification directly add accounts to the managed X list or follow them? | No — host upserts nominations only; `fomo-x-source-review` returns strict JSON; merge fail-closes on missing evidence; shiller/`both` need deterministic historical calls + existing gates; narrative/`both` use 14-day probation before host engagement executor → ADR 009, source-lifecycle.md, knowledge/fomo-family.md | pass | 2026-07-19 |
| P30 | recall | Operator Telegram DMs work — does that mean TG alpha channels are ingesting? Which launchd unit / config / mode? | No — three surfaces. Alpha = `com.trenchcoat.channels` + `telegram_channels[]` (prefer `mode: "preview"`); operator DMs = `com.trenchcoat.listener` + bot token; fanout = `com.trenchcoat.router`. All-`gramjs` + missing session → idle (`preview:0`). Handle `telegram` is the product blog. Digestion: `list-scan-alpha-manifest` / `review-alpha-manifest` → `alpha-digest.json`. Restart **channels** after config change → knowledge/telegram.md, collectors.md, runbook.md | pass | 2026-07-19 |

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
- 2026-07-18 session-learning: Discord-only message caps — `ingestOutbox` no longer
  gates on budget; `renderChannelPayloads` reserves Discord `daily_budget`/
  `urgent_ceiling` and omits `channels.discord` when over (router
  `skipped-discord-budget`); Telegram uncapped after validation.
  `discord_distiller.daily_cap` remains a separate LLM-session cap. INV-B2/B4 +
  CONFIG/orchestrator/router already updated; refreshed P1/P14/P15/P20.
- 2026-07-18 session-learning: broadcasts were silent because (1) no KeepAlive
  router launchd unit, (2) bare `TRENCHCOAT_ROUTER_URL` signed `/v1/events` but
  POSTed `/`, (3) loopback HTTP rejected until validateRouterUrl allowed it,
  (4) `--ignore-scripts` left `better-sqlite3` unbound in runtime. Fixed intake
  + installer rebuild + `com.trenchcoat.router`. Per-channel semantics landed
  (Telegram overview distiller / Discord host distiller). Extended INV-B2; added P19/P20;
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
- 2026-07-18 session-learning (gap closure): Cursor sandbox write≠read —
  outside writes denied with `disableTmpWrite`, outside reads still allowed;
  tmpdir-only escape probes are false failures. Fixed agent-workspace sandbox
  stanza (`workspace-read-write` + `disableTmpWrite: true`); cursor-cli.md FS
  section; P4 refreshed; P27 added; roadmap residual no longer claims isolation
  pending. Gotchas empty.
- 2026-07-18 context-maintenance: Discord-only broadcast caps already in working
  tree (INV-B2/B4, orchestrator/router/CONFIG/TECHNICAL-SPEC) match
  `reserveBroadcast` + `renderChannelPayloads`. INV-I2/I5/B1 verification text
  updated (host-CLI probes green; still PARTIAL for outside-reads + Docker
  reference). NOTES isolation “until green” drained. Gotchas empty. Probe suite
  26/26 pass via clean-context sub-agents. Always-on unchanged (~306 tokens).
- 2026-07-19 context-maintenance: deleted `ops/ROADMAP-2026-07-18-audit.md` left
  broken pointers in README + P4/P24 — repointed to `ops/NOTES.md` § Phase status.
  Bumped 10 stale `last_verified` stamps; ADR index 001–010; NOTES drift rows for
  ADR 009/010; ARCHITECTURE module list + discord-research link. P28/P29 answered;
  probe suite 29/29 pass. Gotchas empty. Always-on unchanged (~306 tokens).
- 2026-07-19 session-learning: Telegram market fanout is overview-distilled
  (not chat-recall dump); Discord unchanged; P20/INV-B2/router/orchestrator/
  CONFIG already updated. Captured: ingress requires `channels.telegram`
  (channel-render before POST); chat-report ≠ TG broadcast text; voice sync
  surfaces (`AGENTS.md` / `PERSONA_VOICE` / `TELEGRAM_OVERVIEW_PROMPT`) + installer
  does not sync `agent/`. Live dirty deploy + `telegram_overview.enabled` noted in
  LIVE-E2E-BLOCKERS. Gotchas empty.
- 2026-07-19 session-learning (TG alpha ingestion): seed/live allowlist was
  all-`gramjs` with no session → poller idle while operator DMs still worked;
  stale `alpha-queue/telegram` was the official product blog handle. Fixed
  preview-first seed + live config, purged stale queue/cursors, added
  `list-scan-alpha-manifest`, synced list-scan skill + redeployed. Knowledge in
  `docs/knowledge/telegram.md` + collectors/runbook/LIVE-E2E; added P30; refreshed
  P4. Gotchas empty.
