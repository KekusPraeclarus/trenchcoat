# Context Probes

Golden questions a fresh agent should answer from the context graph alone.
Run during context maintenance; treat failures as selection bugs, not knowledge bugs.
See `~/.cursor/skills/context-engineering/refs/context-probes.md`.

| ID | Type | Question | Expected pointer or fact | Last result | Date |
|----|------|----------|--------------------------|-------------|------|
| P1 | recall | Which broadcast severity bypasses the Discord daily budget, and what still constrains Discord sends? | Discord `urgent` bypasses `daily_budget`; schema check + Discord `urgent_ceiling` (default 10/day). Telegram has no daily count limit after validation. Over Discord budget omits `channels.discord` (router `skipped-discord-budget`) → orchestrator.md "Outbox → router", INV-B2/B4 | pass | 2026-07-20 |
| P2 | recall | Who is allowed to write `state/sources.json`, and why is that restricted? | Only deterministic host code: audit scoring maths, rug-shill dock, operator undock/confirm, neutral auto-registration; never a model session, so shilled content can't vouch for its own source → INV-S7/S12, agent-workspace.md | pass | 2026-07-20 |
| P5 | recall | A candidate surfaces on a chain we don't support — what happens, and how do we add the chain? | Fail-closed for tracking without registry/scanner (INV-S9). Manual add = `chains/<slug>.json` + `pnpm generate:chains` + provider verification. Discord exact unknown `slug:address` may enqueue host chain-integration (ADR 016) — research-only OK without scanner; never auto-enables wallet/Fomo → chains.md, discord-chain-integration.md | pass | 2026-07-20 |
| P43 | recall | After Discord chain-integration deploys, why must announce/research handoff not stay in the pre-deploy worker, and how is research quota reserved meanwhile? | New slug is only in the **newly deployed** registry — worker runs `tc discord chains continue <id>` from `~/.trenchcoat/runtime`. Reservation uses Discord status `awaiting-chain` so FIFO pump skips it until promote. Deploying phase is drain idle-safe; chain-integration launchd job is not bootout on deploy pause → discord-chain-integration.md, ADR 016, INV-D2/S26 | pass | 2026-07-20 |
| P6 | recall | Why can't the audit accidentally grade a decision with hindsight? | The as-of bundle freezes evidence; execution/outcomes use immutable post-event observations; a sealed epoch freezes cohort/versions; source scores lag one cycle → INV-S14/S18, snapshot-archive.md | pass | 2026-07-20 |
| P3 | artifact | Where does Farcaster (Neynar) live, and what does ops enablement still need? | Implemented under `src/collectors/farcaster/` with `farcaster-scan` / `fc-source-review` (ADR 007); enable via `farcaster.enabled` + Neynar/signer auth → collectors.md, TECHNICAL-SPEC, knowledge/neynar.md | pass | 2026-07-20 |
| P4 | continuation | What is the offline vs live acceptance status of the implementation? | Offline suites green; Phase 0–3 DONE (2026-07-18 audit response, `ops/NOTES.md` § Phase status); managed list + `--sync-env` + reversible X + TG **preview-first alpha** (33 channels live 2026-07-19) + live isolation write/network/injection operator-verified; residual = GramJS auth/CLI injection for preview-disabled channels + INV-I1 outside-read PARTIAL + INV-I5 container reference-only → `ops/LIVE-E2E-BLOCKERS.md` | pass | 2026-07-20 |
| P24 | continuation | What is next after Phase 3 of the 2026-07-18 audit roadmap? | Phase 3 DONE (3A host prechecks + skip ledger, 3B market-blind narrative attention, 3C follow dedupe + live follow). Further work is ops hardening / remaining PARTIAL invariants — not a numbered Phase 4; status in `ops/NOTES.md` + `ops/LIVE-E2E-BLOCKERS.md` | pass | 2026-07-20 |
| P27 | recall | Does the host Cursor sandbox block reads and writes outside `agent/` equally? | Writes outside are blocked (`--sandbox enabled` + `disableTmpWrite: true`); outside reads still succeed on current CLI — INV-I1 PARTIAL; never rely on tmpdir-only escape probes → knowledge/cursor-cli.md, agent-workspace.md, INV-I1 | pass | 2026-07-20 |
| P7 | recall | How does trenchcoat authenticate Cursor agent job sessions? | Cursor CLI login (`agent login` / `agent status`), headless `agent -p --trust --workspace agent/`; not `@cursor/sdk` / required `CURSOR_API_KEY` → ADR 003, docs/knowledge/cursor-cli.md | pass | 2026-07-20 |
| P8 | recall | What must stay true when merging parallel feature worktrees? | Integration owner exclusively merges `package.json`, `src/contracts/**`, `src/orchestrator/run.ts`, `src/orchestrator/collect.ts`, `docs/INVARIANTS.md`; cherry-pick non-overlapping files and reconcile duplicate APIs before declaring green → docs/development.md | pass | 2026-07-20 |
| P9 | recall | Who may add or remove members of the bot-managed X list, and from what evidence? | Only host lifecycle code after lagged settled direct bullish raw-CA outcomes; FYP text/model/engagement cannot promote; operator lists are immutable inputs → ADR 004, source-lifecycle.md, INV-S21 (PARTIAL until sealed outcomes feed review) | pass | 2026-07-20 |
| P10 | recall | Which X network mutations are allowed, and what must match before any membership change? | Only GraphQL `CreateList`/`ListAddMember`/`ListRemoveMember` in the host synchronizer; target list id must equal persisted managed list id; scrapers stay read-only → INV-R2 (PARTIAL — allowlists ENFORCED; like throttle config-default), knowledge/x-playwright.md | pass | 2026-07-20 |
| P11 | recall | Where does the X burner Playwright profile live, and is it `browser-profile`? | `~/.trenchcoat/twitter-profile/` only; never under `agent/` or the repo; name is not `browser-profile` → knowledge/x-playwright.md, collectors.md | pass | 2026-07-20 |
| P12 | recall | Can the agent like FYP posts, and does that promote managed-list membership? | Agent owns like/follow choices; likes must target same-run FYP post ids; proposal-time subscription dedupe (`already_liked` / `already_following` / `not_following` / `pending_duplicate`); default ≤2 likes / 10 min (INV-S22 PARTIAL); engagement never writes managed-list or source scores → INV-S22, source-lifecycle.md, x-playwright.md | pass | 2026-07-20 |
| P13 | recall | Can the scheduled `harness-improve` job activate the live agent workspace or start a canary? What may candidate canaries never do externally? | Scheduled job may plan/review/build, push ff-only to `origin/main` then local main (`push_origin`), and deploy host runtime — ends at `activation_pending`; never activates `~/.trenchcoat/agent` while drain busy, never starts canary until `tc harness activate`; canaries block candidate external effects → ADR 005, architecture/harness-improvement.md, INV-S24/S25 | pass | 2026-07-21 |
| P32 | recall | After a config schema bump, which three sites must stay aligned for deploy provenance, and where is the previous runtime kept on rollback? | `ConfigSchema`/migrations, `DEPLOYMENT_CONFIG_SCHEMA` (`deployment.ts` / health `expectedSchema`), and `ops/install-launchd.sh` `configSchema` must match; previous runtime is `~/.trenchcoat/runtime.prev` (not `runtime.previous`) → orchestrator.md Deployment manifest, runbook.md | pass | 2026-07-20 |
| P33 | recall | What evidence must sealed epochs carry before `harness-improve` can grade a candidate, and what happens if they lack it? | Distinct development + unused holdout epochs with archived non-empty decision-time `signals` on each subject; missing signals → typed safe skip (empty `{}` replay removed) → harness-improvement.md, `src/harness/signals.ts` | pass | 2026-07-20 |
| P14 | recall | Who may write `state/wallets.json`, and how do wallet add/drop events relate to the Discord market budget? | Host-only (discovery/scan/review/seed); evidence-only `wallet-evidence` agent may write advisory `wallet-evidence.md` only — never state/scores/cursors/lifecycle; each applied transition emits one `wallet.lifecycle` router event on a lane that does not consume Discord `daily_budget`/`urgent_ceiling` → smart-wallets.md, ADR 002, INV-S19/S20 | pass | 2026-07-20 |
| P51 | recall | How does Discord wallet-signal confluence differ from smart-wallet tracking, and when is silence bearish? | Separate lane (`discord-wallet-signal-scan`, ADR 035): REST-poll Cielo/relay channels; buy confluence ≥K actors is bullish confirm (+ optional research enqueue when `shadow_mode` false); sell pressure is inbox/context only; silence never bearish; never writes `wallets.json` → discord-wallet-signals.md, INV-S19 | pass | 2026-07-23 |
| P15 | recall | What are the two “outbox” surfaces, and which module stages router delivery? | `agent/outbox/<run-id>.json` = BroadcastItem proposals; host `ingestOutbox` validates/stages with no Telegram count limit → `archive/router-outbox/` via `src/lib/outbox.ts`; then `renderChannelPayloads` (Telegram always; Discord at most once per run when budget allows, else omit / `run-deduped`) then `deliverStagedOutbox`. No `src/orchestrator/outbox.ts`. HMAC in `src/orchestrator/router.ts` → orchestrator.md "Outbox → router", INV-B2 | pass | 2026-07-20 |
| P16 | recall | When does `narrative-scan` fire a broadcast, and who owns/prunes the rolling log? | `state/narratives/log.jsonl` is host-owned/integrity-protected; agent proposes updates in `reports/<run-id>/narrative-proposals.jsonl` (incl. optional monotonic framing maturity `rotation`→`ecosystem`/`regime` with rotation-free title; slug stays stable — ADR 036) and outbox items for new slugs, stage changes, notable same-stage developments (incl. framing maturity), or founder/protocol primary-source catalysts (no CT-cluster/stage-shift prerequisite). Same-stage `narrative-emergence`/`rotation` claims are compatibility-routed through development novelty dedupe (48h accepted-claim window); pure status-quo restatements and stale lane-“rotation” wording against matured subjects (`stale-narrative-framing`) stay rejected. Host `mergeNarrativeProposals` then `pruneNarrativeLog` (default 14d retention) → ADR 023/036, agent-workspace.md, orchestrator.md | pass | 2026-07-24 |
| P47 | recall | Chat digest lists a broadcast but Telegram/Discord stayed quiet — where is truth, and what gates run before fanout? | Chat recall lists **proposals**; confirmed fanout is `archive/transactions/` router receipts for `finding.broadcast` with delivery status. Pre-stage rejects land in `broadcast-rejects.json` (`narrative-unchanged-stage`, development repeat, `worthiness:…`, schema). Worthiness "already broadcast" may use **accepted** delivery history only (ADR 014/023), not status-quo narrative state. Research must propose outbox for resolved conclusions; invalid verdicts (`watch`/`pass`) fail proposal load → orchestrator.md § Broadcast audit, ADR 023 | pass | 2026-07-22 |
| P48 | recall | Operator says a founder announcement was "missed" — timeline miss or agent miss, and what must happen next time? | Grep sealed `archive/runs/*/inbox/` first. Evidence present + empty outbox / "incremental sentiment" = agent judgment miss (ADR 024), not collectors. Founder/protocol primary-source catalysts must broadcast without CT cluster or stage shift (skills + worthiness); host does not invent outbox (INV-B2). Also check failed/`--skip-agent` runs. → orchestrator.md § Broadcast audit, ADR 024, INV-B2 | pass | 2026-07-22 |
| P49 | recall | Operator Telegram says `approve remediation Rem 92da…` (space/capital) and chat replies “Approval noted” — did the host approve? | Only if host `normalizeRemediationIncidentId` / `parseRemediationCommand` applied first, or forwarded intent from the agent reply. Chat “noted” alone does not mutate the ledger. Recovery: `tc remediations approve rem-<id>` on the VPS. → ADR 030, telegram.md, incident-remediation.md | | 2026-07-23 |
| P50 | recall | How does a long-running RH “rotation” stop being called a rotation? | Agent proposes `framing: ecosystem\|regime` + rotation-free `title` + `framingEvidence` after multi-run observation and durable ecosystem evidence (time alone insufficient). Host merges monotonically into `log.jsonl` (slug unchanged); preferred labels use the title; outbox/distill reject `stale-narrative-framing` for lane-“rotation” wording. Capital-flow claim type `rotation` stays separate. → ADR 036, agent-workspace.md, INV-B2/S23 | pass | 2026-07-24 |
| P50 | recall | Why can wallet scans starve `outcomes-settle` / `wallet-review`, and what fixes it? How do paper track positions leave `entry-pending`? | Pre-ADR 031 scans held `agent/.lock` for Cursor+Helius; settle/review exited 3. Fix: those jobs + wallet-scan are lock-exempt with brief RMW only; scans host-only + `max_wallets_per_scan`. Entries finalise via host `settle-ledger` in `outcomes-settle` (decisionTs + first post-decision bar); drop on unfilled → `censored`. Never hand-edit `ledger.json`. → ADR 031, smart-wallets.md, INV-S10/S15 | | 2026-07-23 |
| P51 | recall | Telegram got a market broadcast but Discord did not — first place to look, and what are hot-day ops caps? | `archive/runs/<run-id>/channel-render-receipts.json`: `budget-skipped` (`budget:daily-budget`) or `run-deduped`. Discord message lane hot-day ops **100/100** (`daily_budget`/`urgent_ceiling`, schema max 200); Telegram message count stays uncapped; `telegram_overview.daily_cap` is LLM sessions only (ops **50**). → ADR 033, router.md, knowledge/discord.md | | 2026-07-23 |
| P17 | recall | Is Neynar/Farcaster phase-2 or shipped, and which ADR binds it? | Shipped host path (`farcaster.enabled`, `farcaster-scan` / `fc-source-review`); ADR 007 — not phase 2 → TECHNICAL-SPEC §15, source-lifecycle.md | pass | 2026-07-20 |
| P18 | recall | What is authoritative completed-run durability — per-run git commit or archive journal? | Archive journal (`archive/transactions/`); Git is backup-only (`tc backup`) and never gates completion → ADR 006, orchestrator.md, INV-S8 | pass | 2026-07-20 |
| P19 | recall | Must the router process be running for broadcasts to reach Telegram/Discord, and how is it scheduled? | Yes — jobs only stage + HMAC-POST; fanout is the KeepAlive `com.trenchcoat.router` (`tc router serve`) via `install-launchd.sh`. Needs `TRENCHCOAT_ROUTER_*` + destination env (`TELEGRAM_ROUTER_BOT_TOKEN`/`CHAT_ID` and/or `DISCORD_WEBHOOK_URL`). Runtime install rebuilds `better-sqlite3`. Bare intake URL defaults to `/v1/events`; loopback HTTP allowed → router.md, runbook.md | pass | 2026-07-20 |
| P20 | recall | What text does Telegram vs Discord get for a market broadcast, and where do the rewrites run? | Telegram: fail-closed landscape overview from promoted chat report when `broadcast.telegram_overview.enabled` (`distill-session.ts` / `renderChannelPayloads`) — longer chat-style, may restate current narrative heat, no host plumbing/paths/provenance or bare @handles, no trader roll calls, ≤8k; host injects `watchWindow` (ADR 013, decoupled from settlement `horizonHours`); fanout markdown→HTML + deslug + thin `24h|72h|168h` scrub; else short `event.text`; uncapped after validation. Discord: fail-closed **own** bottom-line distill (≤320, ≤3 tickers, no provenance/bare @handles, no trader roll calls, no status-quo filler / unchanged-stage restatement) — never reuse TG overview/closer; at most one Discord payload per run (later claims `run-deduped`, no budget burn); else `event.text` on the first eligible event. Message count uses `broadcast.daily_budget`/`urgent_ceiling` (omit `channels.discord` when over → router `skipped-discord-budget`); `discord_distiller`/`telegram_overview` `daily_cap` share an LLM-session used counter. Distillers are orchestrator-side, never inside the router. `wallet.lifecycle` never distilled → router.md, INV-B2, ADR 013 | pass | 2026-07-20 |
| P21 | recall | When does narrative-scan enqueue research, and can resolution put a token on the watchlist? | Host `bridgeNarrativeTickers` after integrity: new slug or transition to `peaking`; trigger `narrative`; ambiguous stays ambiguous; resolution never writes watchlist — only a later dossier-bound gate-passing research proposal can track → research-queue.md, token-resolution.md, INV-S9/S10 | pass | 2026-07-20 |
| P25 | recall | Does scheduled `research` still run when the queue is empty? | No — dequeue before `createRunId`; empty / pending-not-due / daily-cap appends `archive/skips/research.jsonl` and returns `runId: "none"`; `tc precheck` is lock-free peek only; due entries stay in-file as `researching`; cron defers `preArchiveRun` until after `runResearchPasses` → research-queue.md, orchestrator.md | pass | 2026-07-20 |
| P23 | recall | Where does narrative-scan get market attention, and what happens when CoinGecko categories are missing? | `fetchMarketAttentionForNarrative` in `providers.ts` (retry + Dex/Gecko fallback) — not `aggregate.ts`/`market-bars.ts`; missing categories → `marketBlind` + `degraded`; host rejects rotation broadcasts → market-risk.md, collectors.md, INV-R3 | pass | 2026-07-20 |
| P26 | recall | What does `tc precheck <job>` do vs a host precondition skip inside `runJob`? | Precheck is lock-free best-effort (exit 10 = skip); `runJob` re-checks under lock and appends `archive/skips/<job>.jsonl` with `runId: none` (no journal). Host-gated: chart/watchlist/research/wallets/review → orchestrator.md, development.md | pass | 2026-07-20 |
| P28 | recall | How does Discord interactive research differ from Discord market broadcasts? | Two surfaces: router webhook `DISCORD_WEBHOOK_URL` (budgeted broadcast fanout) vs Gateway `DISCORD_RESEARCH_BOT_TOKEN` + `tc listen discord` (isolated `~/.trenchcoat/discord/`, ✅ start reaction then final-only text replies, INV-D1, ADR 010) → discord-research.md, knowledge/discord.md | pass | 2026-07-20 |
| P29 | recall | Can Fomo X-source classification directly add accounts to the managed X list or follow them? | No — host upserts nominations only; `fomo-x-source-review` returns strict JSON; merge fail-closes on missing evidence; shiller/`both` need deterministic historical calls + existing gates; narrative/`both` use 14-day probation before host engagement executor → ADR 009, source-lifecycle.md, knowledge/fomo-family.md | pass | 2026-07-20 |
| P30 | recall | Operator Telegram DMs work — does that mean TG alpha channels are ingesting? Which launchd unit / config / mode? | No — three surfaces. Alpha = `com.trenchcoat.channels` + `telegram_channels[]` (prefer `mode: "preview"`); operator DMs = `com.trenchcoat.listener` + bot token; fanout = `com.trenchcoat.router`. All-`gramjs` + missing session → idle (`preview:0`). Handle `telegram` is the product blog. Digestion: manifest → `alpha-digest.json` with **`entries` + contentHashes** (never narrative `items`); wrong shape → `invalidReason` / purge 0. Sync skills into `~/.trenchcoat/agent/skills/`. Restart **channels** after config change → knowledge/telegram.md, collectors.md, runbook.md | pass | 2026-07-20 |
| P31 | recall | Discord research reply landed but later requests stay `queued` — what usually holds the pump, and is watch baseline a second X scrape? | `.worker.lock` held for whole unit; hung Playwright X in dossier (or legacy post-reply scrape) blocks FIFO. Reclaim orphans on listener start; purge = mark `failed` + restart worker. Baseline is dossier-derived (no second Dex/security/X). Skills under `discord/agent/skills/` do not auto-sync on deploy → discord-research.md ops, knowledge/discord.md | pass | 2026-07-20 |
| P34 | recall | Does active mint authority hard-fail the security gate? When is a mintable token blocked from tracking / Discord subscribe? | No — `mintable`/`mint-authority` are caution-only (like `low-lp-lock`). Host blocks `track`/subscribe when mint is active and model `projectClassification` is `memecoin`, or classification is missing; justified utility/infrastructure may track. Contextual reject does not rug-dock. Discord subscribe also requires a validated `track` verdict (`evaluateResearchSubscribe`) → ADR 011, security-gate.md, INV-S9 | pass | 2026-07-20 |
| P35 | recall | Chat says list-scan wrote an alpha digest / “processed” Telegram — were queue messages purged? Why can backlog stay ~500? | Only host `alpha-digest-receipt` with `purgedIds` counts. Agent `reports/.../alpha-digest.json` with narrative `items` fails Zod (`invalidReason=schema-invalid`) and purges nothing (INV-Q1/Q2). Check chat `alphaPurged` / `alphaDigestInvalid`. Do not mass-delete the queue. `analysis-only` + `repeated_two_hash_stale` is **Farcaster**, not X list-scan → telegram.md, orchestrator.md § Alpha-queue, INV-Q1 | pass | 2026-07-20 |
| P36 | recall | Do list-scan and farcaster-scan share one jitter range? After shortening cadence, why might the old schedule still block runs? | No — per-job `MIN_SEC`/`MAX_SEC` in `ops/run-job-jittered.sh` (list-scan [30m, 1h45m]; farcaster [3h15m, 4h45m] as of 2026-07-19). Success backoff persists in `~/.trenchcoat/var/<job>.next` across redeploy; delete to apply immediately. TG preview cycle is `channels.ts` default + **channels** restart; verify startup `pollMs` → runbook.md § Tuning social scan cadence, telegram.md | pass | 2026-07-20 |
| P37 | continuation | What must happen before Fomo jobs can mutate wallets / research queue / X nominations in production? | Burner `auth fomo` + live smoke (`pnpm fomo:smoke`) + `fomo:install-gates` with provider/capability `pass` (operator override or FAFO). Prefer 14-day shadow (`SHADOW-CANARY.md`) before `shadow_mode: false`. Profile `~/.trenchcoat/fomo-profile/` only. `probe:fomo` is discover/status/sanitize scaffold — no evaluate yet → development.md, LIVE-E2E-BLOCKERS, knowledge/fomo-family.md, ADR 009 | pass | 2026-07-20 |
| P38 | recall | FC scans run but for-you is `repeated_two_hash_stale` / `analysis-only` — is engagement on, and which platforms carry live social? | Engagement off (only live for-you hashes authorize likes). Agent may still run on trending fallback = analysis noise, not recovery. X + Telegram carry live signal until for-you `live>0`. `empty-following-with-desired` ≠ healthy empty graph. As of 2026-07-19: `farcaster.enabled=false` pending mobile feed tuning (junk 2061/2076 for-you hashes) → LIVE-E2E § Farcaster, knowledge/neynar.md | pass | 2026-07-20 |
| P39 | recall | A completed run still shows `status: running` in `archive/runs/<id>/journal.json` — is it stuck? | No — per-run `journal.json` is a seal-time snapshot (`host-prepared` only). Authoritative terminal status is `archive/transactions/<id>.json` (ADR 006); agent mirror `reports/<id>/journal.json` updates on each phase advance → orchestrator.md § Run idempotency, snapshot-archive.md | pass | 2026-07-20 |
| P40 | recall | What happens when a list-scan Twitter bundle exceeds 500 posts? | Host caps at `SNAPSHOT_MAX_ITEMS` (500) with trailing `truncated=N` via `capEnvelopeItems`; FYP summary pre-sliced so INV-S22 engagement cannot like off-snapshot posts; `collectionStatus` may note `posts-truncated=N` / `casts-truncated=N` → collectors.md, `review-collect.ts` | pass | 2026-07-20 |
| P41 | recall | Chat recall `reports/chat/<run-id>.md` still says `status: running` after a successful run — is the run stuck? What rewrites status? | Not stuck: host promotes chat recall mid-run after alpha purge with in-flight status; `finalizeChatReportRunStatus` rewrites the `- status:` line to `complete`/`failed` at terminal journal advance. Distinct from ADR 006 trap (`archive/runs/<id>/journal.json` seal-time only) → orchestrator.md § Run idempotency, chat-agent.md | pass | 2026-07-20 |
| P42 | recall | Why must channel copy not paste `72h`, and is `watchWindow` on the outbox proposal? | Host derives `watchWindow` at distill from claim type + `horizonHours` (ADR 013); settlement stays 24/72/168. Not agent-authored. Thin scrub only replaces leaked hour tokens; natural phrases stand. TG fanout is HTML + narrative deslug → watch-window.ts, telegram.md, INV-B2 | pass | 2026-07-20 |
| P44 | recall | When does Discord idea-tracking alert a user, and is the alert a reply to their track request? | Silent until host-validated ticker/CA in matched candidate + deep research; initial notify only if `mainTrackEligible`. Else await 3 unique later mentions → `composer-2.5-fast` review (reject = 7d blacklist). Alert is a **non-reply** channel message `@user I found a token matching <shortLabel>` + full research; `shortLabel` as stored. Dedupe `(trackingId, chain, tokenAddress)`. Schema default `enabled` does not override explicit live config. → ADR 018/019, discord-tracking.md, knowledge/discord.md, INV-D6/D7 | pass | 2026-07-21 |
| P45 | recall | Telegram DM says chat turn timed out ~30–90s after idle, with no `chat turn start` in listener logs — what failed, and what does the host do now? | Idle rotation’s `agent create-chat` (90s) hung/failed under load; host resumes prior same-operator chat id instead of failing the turn (rotation is hygiene). Handler logs underlying `detail`. → chat-agent.md Session policy / Gotchas, knowledge/cursor-cli.md | pass | 2026-07-21 |
| P46 | recall | Where do smart-wallet addresses come from, and what alert fires when tracked wallets converge on a fresh token? | On-chain verified buys only (Helius/Infura/Robinhood) — never Fomo profile addresses. Runner discovery qualifies fresh pools then recurrence ≥2/30d (`origin: new-pools`). ≥4 event-time `tracking` wallets → host-rendered `UNVERIFIED WALLET CONVERGENCE` + independent `wallet-convergence` research enqueue; defaults shadow/off until ADR 020 canary gates → smart-wallets.md, ADR 020, `ops/runner-wallet-canary.md`, INV-S19/S29 | pass | 2026-07-21 |

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
- 2026-07-19 session-learning (Discord accelerate + condense): parallel dossier /
  Tavily + dossier baseline (no post-reply X) + delivery under `.lock`; chat
  summary TL;DR/X/Web/Read ~one message. Stuck queue was hung Playwright holding
  `.worker.lock`. Cold `tc listen` ESM load ~10–20s; bootstrap error 5 recovery;
  discord skills not auto-synced. Drained list-scan alpha-manifest + Neynar
  trending-limit gotchas (already in collectors/telegram/neynar); dirty-deploy
  config wipe → runbook. Added P31. Gotchas empty.
- 2026-07-19 session-learning (agent-gated harness): ADR 005 flipped human PR gate
  → plan/review agents + local-main/deploy; agent sync drain-gated. Surprises:
  `install-launchd.sh` / health still hardcoded `configSchema` 9 after schema 11
  bump (triple-sync rule → orchestrator.md); rollback path is `runtime.prev` not
  `runtime.previous` (runbook/LIVE-E2E fixed); empty `{}` holdout replay removed
  (epochs need decision-time signals or skip). TECHNICAL-SPEC §8 updated. Added
  P32/P33. Gotchas empty.
- 2026-07-19 session-learning (contextual mint): ADR 011 — mintable/mint-authority
  caution-only; host blocks mintable memecoins via `projectClassification`;
  Discord subscribe requires validated `track` (`evaluateResearchSubscribe`);
  no rug-dock on contextual reject. Docs already in security-gate / INV-S9 /
  discord-research from the change; added ADR + P34; market-risk pointer.
  Gotchas empty.
- 2026-07-19 session-learning (list-scan outage + alpha backlog): Afternoon
  list-scan died on uncapped alpha manifest (`too_big`) then Playwright
  browser-closed (false `config-error` from `--disable-field-trial-config`).
  Cap + `scrapeTargetsWithRecovery` + `classifyRunFailureCode` landed.
  ~500 TG queue backlog was **zero purges** — agent wrote narrative `items` into
  `alpha-digest.json`; host now `invalidReason` + chat notes; skills teach
  `entries`+hashes; synced to `~/.trenchcoat/agent/skills/`. FC
  `analysis-only`/`repeated_two_hash_stale` ≠ X. Updated INV-Q1/Q2, telegram,
  x-playwright, LIVE-E2E; P30 refreshed; added P35. Gotchas empty.
- 2026-07-19 session-learning (scan cadence bump): list-scan jitter → [30m, 1h45m];
  TG preview default → 30m (`pollMs:1800000`); farcaster unchanged in same script.
  Ops: `.next` files gate until deleted; partial install can leave channels
  unloaded after listener bootstrap error 5 — verify + manual bootstrap. Added
  runbook § Tuning social scan cadence, x-playwright cadence note, telegram
  pollMs verify, P36. Gotchas empty.
- 2026-07-19 context-maintenance: lint 0/0; gotchas empty; ADR 011 added to
  NOTES drift table; security-gate promoted draft→active; discord-research source
  index + orchestrator alpha-drain operator path; bumped stale `last_verified`
  on chains/helius/infura/chart-vision. P31/P34/P35/P36 graded pass. Probe suite
  36/36 pass. Always-on unchanged (~306 tokens).
- 2026-07-19 context-maintenance + session-learning (Fomo Playwright): Fomo
  dual-track + profile-history already in ADR 009 / collectors / fomo-family /
  INV-S21/S22. Surprises: work still local/uncommitted (not live); INV-I4
  false-positive when a file reads `agent/inbox` and `writeAtomicFile`s archive
  (tightened static test + development.md note); probe cmd block needed
  sanitize/evaluate. Expanded LIVE-E2E Fomo residual; added P37; regraded
  P29 + Fomo profile path. Probe suite 37/37 pass. Gotchas empty. Always-on
  ~306 tokens.
- 2026-07-19 session-learning + context-maintenance (FC feeds stale): Live
  for-you stuck on `repeated_two_hash_stale` (hash collection not refreshing);
  following often `empty-following-with-desired`; engagementDisabled while
  agent still runs on trending fallback = analysis-only noise. Operator:
  X/TG carry signal. Fixed doc drift (for-you reject ≠ skipAgent). LIVE-E2E
  § Farcaster feed health; neynar/collectors/source-lifecycle/ADR 007/runbook;
  P38. Lint 0/0; gotchas empty; always-on ~306 tokens.
- 2026-07-19 session-learning (FC disable): Root cause confirmed — for-you
  only returns two future-dated junk casts (2061 greg / 2076 akimaru), no
  cursor; openrank fails for FID. Set live `farcaster.enabled=false`; LIVE-E2E
  § Farcaster rewritten with re-enable checklist after mobile feed tuning.
  P38 expected pointer updated.
- 2026-07-19 context-maintenance: lint 0/0; gotchas empty; fixed stale
  `Farcaster feed health` § pointers (runbook, collectors); neynar paragraph
  merge; bumped `last_verified` on ADR 007, cursor-cli, snapshot-archive,
  audit-metrics, token-resolution, tavily. ENFORCED rows spot-checked (P1/S6/B5/R3/D1
  sites present). Probe suite 38/38 pass. Always-on ~306 tokens.
- 2026-07-20 session-learning (Discord fanout): Discord is its own ≤320
  bottom-line distill, at most once per run (`run-deduped`); never reuse TG
  overview/closer text (multi-claim reworded dupes). No trader roll calls on
  either channel. Deploy: `install-launchd` does not sync `AGENTS.md`/skills;
  post-reload may leave stale `.lock` (clear when pid dead). Updated router.md,
  runbook, P15/P20, INV-B2 earlier same session. Gotchas empty.
- 2026-07-20 context-maintenance: lint 0/0; gotchas empty; Discord own-distill
  docs (router/orchestrator/telegram/runbook) + P15/P20 refresh; added P41
  (chat-report finalize vs ADR 006 journal trap); ADR `last_verified` backfill
  001–011; market-risk stamp; NOTES/LIVE-E2E redeploy-pending; ENFORCED rows
  P1/S6/B5/R3/D1 sites present. Probe suite 40/40 pass via clean-context
  sub-agents. Always-on unchanged (~306 tokens).
- 2026-07-20 session-learning (Discord chain integration): Host lane ADR 016 /
  INV-D2/S26; manifests under `chains/`; schema 12; post-deploy **must**
  `tc discord chains continue` from new runtime; reservation status
  `awaiting-chain`; build model `cursor-grok-4.5-high`; deploying idle-safe.
  Updated knowledge/discord, chains.md, P5, added P43. Gotchas empty.
- 2026-07-21 session-learning (gated tracking alerts): Live match-first
  `I see talk of` pings rejected; ADR 019 research-first gate (ticker/CA,
  `mainTrackEligible`, three-mention `composer-2.5-fast` review + 7d blacklist,
  non-reply `shortLabel` + full research). ADR 018 cites 019 for delivery.
  Ops note: schema default ≠ live config override; @mention always runs intent
  classifier (`none` = ignore). Added P44. Gotchas empty.
- 2026-07-21 session-learning (Telegram chat timeout): Operator DMs
  “Any social / fomo updates?” hit `chat turn timed out` ~1–2m with no
  `chat turn start` in logs. Root cause: idle session expiry → `create-chat`
  (was 30s) hung under post-deploy load / concurrent Discord research; handler
  swallowed error detail. Fix: create-chat timeout 90s; on failure resume prior
  same-operator chat id; handler `log.error` with detail. Added P45; docs in
  chat-agent.md + cursor-cli.md. No new ADR (ops resilience, not architecture).
  Redeploy listener required for live. Gotchas empty.
- 2026-07-22 context-maintenance: lint 0/0 after bumping 4 stale `last_verified`
  stamps (ADR 015/016, collectors, discord-chain-integration). Gotchas empty.
  ARCHITECTURE.md still said adr 001–011 and omitted worthiness in broadcast
  boundary — fixed to 001–024 + ADR 014/023/024 gates. README always-on layer
  updated (~833 tokens incl. live-vps rule). ADR 023/024 drift rows in NOTES;
  graded P47/P48 pass (broadcast audit + founder miss diagnosis). ENFORCED rows
  P1/S6/B5/R3/D1 spot-checked at cited sites. Probe suite 48/48 pass.
- 2026-07-23 session-learning: ADR 031 (wallet settle/scan brief locks +
  `settle-ledger`); INV-S10/S15 cite 031; P50 added; gotchas empty. Deploy of
  031 still pending for live settle/review.

| P51 | recall | Where do Cursor token costs get cut without changing Discord message caps? | Batched x-scan (one list-scan/round), host alpha no-thesis ack, claim-only worthiness + 48h cache, distill `llm_budget_fraction` / hot-day fraction (ADR 034), review-reports-summary bullets, research-candidates-hint, chat turn_count_max — message budgets stay ADR 033 | pass | 2026-07-23 |

- 2026-07-23: ADR 034 token-cost host gates (batched x-scan, host alpha ack, claim-only worthiness cache, distill fractions, review bullets, research hint, chat turn caps). Added P51.
