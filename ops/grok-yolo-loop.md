# Grok YOLO loop log

Automated improvement loop (5hr cadence). Each entry records evaluation, chosen patch, commit, risk, and verification.

---

## Iteration 1 — 2026-07-19

### Pipeline evaluation

Scanned `~/.trenchcoat/archive/runs/` (816 runs), live agent reports under `~/.trenchcoat/agent/reports/`, cron logs in `/tmp/trenchcoat.*.log`, and Discord research under `~/.trenchcoat/discord/`.

**Working well**
- `list-scan` completing with narrative analysis, alpha digest, and verified X engagement (latest: `list-scan-2026-07-19T18-15-07-997Z`)
- `farcaster-scan`, `fomo-trader-sync`, `fomo-signal-scan`, `research`, Discord research pipelines operational
- Post-run verifiers passing; broadcast rejects mostly expected dedupe
- INV-S22 engagement binding intact (2/2 likes verified on recent list-scan)

**Ineffective / broken**
| Issue | Impact | Evidence |
|-------|--------|----------|
| List-scan collector 500-item Zod cap | 4/11 list-scans failed today | `Array must contain at most 500 element(s)` on twitter bundle snapshots |
| Fomo probe missing `evaluate` subcommand | Operator gate install fails | Terminal: `pnpm probe:fomo evaluate` → usage error; `evaluated-gates.json` ENOENT |
| Archive `runs/<id>/journal.json` stale at `host-prepared` | Operator/audit confusion; chat-report shows `running` | Canonical journal in `transactions/` is `complete` but per-run copy is not updated |
| `watchlist-scan` skipped 26h | No watchlist subjects in host state | `no-active-watchlist-subjects` (watchlist empty by design post-research) |
| `narrative-scan` failed once | Job dark since 01:51 UTC | `Journal status is invalid: undefined` |

### Highest-ROI patch chosen

**Cap twitter/farcaster/fyp snapshot envelopes at `SNAPSHOT_MAX_ITEMS` (500) with `truncated=N` marker.**

Rationale: Direct cause of list-scan job failures (alpha loss during peak scrape windows). Same pattern already proven for alpha-manifest capping. Low blast radius — truncation is logged in `collectionStatus`, engagement binding uses capped FYP posts only (INV-S22 safe).

**Deferred (not implemented this iteration)**
- Fomo `evaluate` subcommand — valuable but larger scope; Fomo cron already running after operator gate override
- Archive journal sync on completion — audit/visibility fix; does not block collection
- Narrative-scan journal parse fix — single failure, needs separate investigation

### Changes

| File | What |
|------|------|
| `src/orchestrator/review-collect.ts` | Added `capEnvelopeItems()` helper |
| `src/orchestrator/collect.ts` | Cap twitter/farcaster bundles; cap FYP posts before snapshot + summary; surface `snapshotItemsTruncated` / `posts-truncated` / `casts-truncated` in `collectionStatus` |
| `src/orchestrator/x-fyp-eligible.ts` | Append truncation marker when FYP list pre-capped |
| `tests/unit/list-scan-alpha-manifest.test.ts` | Tests for `capEnvelopeItems` |
| `tests/unit/snapshot-envelope-cap.test.ts` | FYP snapshot cap regression test |
| `docs/architecture/collectors.md` | Document twitter/fyp envelope cap behaviour |

### Risk assessment

| Risk | Blast radius | Mitigation |
|------|--------------|------------|
| Truncated tweets invisible to agent | Agent sees fewer posts from oversized feeds | `truncated=N` marker in snapshot; `collectionStatus` notes count; logs retain full scrape metrics via `postCount` |
| FYP engagement proposes off-snapshot post | Could violate INV-S22 | Summary `fypPosts` sliced to match capped snapshot before engagement binding |
| Farcaster cast truncation | Rare (feeds usually small) | Same marker pattern; `casts-truncated` in status |

**INVARIANTS checked:** INV-P1 (trust envelope unchanged), INV-S22 (FYP binding aligned to capped snapshot), INV-I4 (snapshot writer only). No invariant violations introduced.

### Verification

```
pnpm exec vitest run tests/unit/list-scan-alpha-manifest.test.ts tests/unit/snapshot-envelope-cap.test.ts
# 8 passed
```

### Commit

`c2df162` — Cap collector snapshot envelopes at 500 items to prevent list-scan failures.

(`4985dca` — log hash correction only.)

---

## Iteration 2 — 2026-07-19

### Pipeline evaluation

Re-scanned live archive (`~/.trenchcoat/archive/runs/`), agent reports, `/tmp/trenchcoat.*.log`, and launchd job health.

**Working well**
- Recent `list-scan` / `farcaster-scan` complete with passing post-run verifier; X engagement 2/2 verified (`list-scan-2026-07-19T18-15-07-997Z`)
- Snapshot 500-cap from iteration 1 is in repo (live redeploy still pending by operator policy)
- Fomo trader/signal jobs journal and skip cleanly when gated

**Ineffective / broken**
| Issue | Impact | Evidence |
|-------|--------|----------|
| `run-precheck` hardcodes `run-with-lock-retry.sh` | Host-gated jobs that **pass** precheck never reach `tc run` | `/tmp/trenchcoat.{wallet-scan-solana,wallet-scan-evm,chart-sweep,watchlist-scan}.err.log`: `No such file or directory`; install deploys bare `run-with-lock-retry` |
| Per-run `archive/runs/<id>/journal.json` stuck at `host-prepared`/`running` | Operator/chat still see stale status | Every recent complete run; canonical tx journal is correct |
| `narrative-scan` failed once then dark | No narrative refresh since 01:51 UTC | `Journal status is invalid: undefined` (likely pre-legacy-status live runtime); last success `…T18-07-04-251Z` |
| `harness-improve` failed | Weekly harness dark | `Not a trenchcoat repo root: /` |
| Watchlist/chart empty by design | Expected skip noise | `no-active-watchlist-subjects` |

### Highest-ROI patch chosen

**Resolve lock-retry wrapper as `run-with-lock-retry[.sh]` in `ops/run-precheck.sh` (same pattern as `run-job-jittered`).**

Rationale: Actively breaks every precheck-gated job once prerequisites are non-empty (wallet scans already emitting `skip:false` then dying). List/farcaster survived only because jitter wrappers already had the fallback. One-line class fix; restores INV-S15 lock-retry path for chart/watchlist/research/wallet/review.

**Deferred**
- Archive per-run journal sync on completion — audit visibility; does not block collection
- Narrative-scan / harness-improve root causes — need live redeploy + separate investigation
- Fomo `evaluate` probe subcommand — operator DX; cron already overridden

**Invariant-violating idea (not implemented)**
None this iteration. Syncing per-run journals by rewriting sealed archive bytes would need careful INV-S3/S8 review (ADR 006: transactions/ is authoritative; per-run copy is informational). Prefer copy-forward of the sealed tx journal rather than mutating history in place — deferred, not blocked as a violation yet.

### Changes

| File | What |
|------|------|
| `ops/run-precheck.sh` | Prefer `run-with-lock-retry.sh`, fall back to installed `run-with-lock-retry`; fail closed 127 if neither |
| `docs/architecture/orchestrator.md` | Document install suffix strip + dual-name resolution |

### Risk assessment

| Risk | Blast radius | Mitigation |
|------|--------------|------------|
| Wrong wrapper chosen | All precheck-gated cron jobs | Prefer `.sh` then bare name; executable check; exit 127 if missing |
| Repo-dev path breaks | Local `ops/run-precheck.sh` runs | Layout A/B temp-dir tests both pass |
| Live still broken until redeploy | Operator must run install | Explicit: this loop does **not** update live agent; commit+push only |

**INVARIANTS checked:** INV-S15 (lock contention still goes through retry wrapper), INV-I* untouched (host scripts only), no agent workspace / snapshot / egress changes.

### Verification

```
# Temp-dir layouts: installed (no .sh), repo (.sh), missing→127, old script→ENOENT, fixed→tc run
ALL_OK
```

### Commit

`659cdbf` — Fix run-precheck lock-retry path after install strips .sh.

(`8c60c5d` — log hash correction only.)

### Session learning

- `install-launchd.sh` strips `.sh` when copying ops wrappers into `~/.trenchcoat/bin/`; any new wrapper that execs a sibling must resolve both names (documented in orchestrator.md).
- Empty `ops/gotchas.md` Entries — nothing to drain.

---

## Iteration 3 — 2026-07-19 (hourly tick)

### Pipeline evaluation

Fresh list-scan `list-scan-2026-07-19T20-01-50-074Z` completed with alpha digest, 2/2 X likes, broadcast, chat summary. Core social pipeline healthy.

**Still broken (live not redeployed)**
| Issue | Impact | Evidence |
|-------|--------|----------|
| Iter-2 precheck fix not live | wallet/chart jobs still ENOENT on lock-retry `.sh` | `/tmp/trenchcoat.wallet-scan-*.err.log` as of 21:48 |
| `harness-improve` uses `process.cwd()` | Weekly harness dead under launchd | Failure `Not a trenchcoat repo root: /`; plist has no WorkingDirectory |
| Chat-report `status: running` | Operator recall lies after success | Latest chat-report.md; caused by promote-at-alpha-purged + seal-time per-run journal (ADR 006 by design) |

### Highest-ROI patch chosen

**Resolve harness repo root via `TRENCHCOAT_REPO_ROOT` (install writes it), require `.git`+`package.json`, stop using bare `cwd`.**

Rationale: Complete job-class failure with clear RCA. Chat-status is noisy but ADR-documented; fixing it is a follow-up consumer patch, not journal redesign. Precheck already fixed in-repo pending operator redeploy.

**Deferred**
- Live install of iter-2/3 (operator policy: do not update live agent from this loop)
- Chat-report final status refresh at `complete` (consumer fix; leave seal-time journal alone per ADR 006)
- Narrative-scan legacy status (likely fixed in repo; needs live runtime)
- Fomo `evaluate` probe

**Invariant note (not implemented)**
Rewriting sealed `archive/runs/<id>/journal.json` after completion would blur ADR 006's seal-time-copy contract. Prefer chat-report finalize or reading `transactions/` — deferred, not coded.

### Changes

| File | What |
|------|------|
| `src/harness/pr.ts` | `resolveHarnessRepoRoot`; `assertRepoRoot` requires `.git` and `package.json` |
| `src/orchestrator/run.ts` / `src/cli.ts` | Use resolver for harness-improve + activate |
| `ops/install-launchd.sh` | `upsert_repo_root_env` into `~/.trenchcoat/env` |
| `docs/CONFIG.md`, `docs/architecture/harness-improvement.md`, `.env.example` | Document env |
| `tests/unit/harness-repo-root.test.ts` | Env prefer, cwd fallback, runtime reject, `/` reject |

### Risk assessment

| Risk | Blast radius | Mitigation |
|------|--------------|------------|
| Wrong path in env | harness-improve + activate | assert requires `.git`+`package.json`; runtime tree rejected |
| Stricter assert breaks old package.json-only fixtures | harness callers | Unit tests; schedule tests still green |
| sed upsert corrupts env | `~/.trenchcoat/env` | Only replaces `TRENCHCOAT_REPO_ROOT=` line; mode 600 atomic mv |

**INVARIANTS:** INV-S24 (harness still confined; no live activate/push); INV-I3 (path is not a secret, written to host env outside `agent/`).

### Verification

```
pnpm exec vitest run tests/unit/harness-repo-root.test.ts tests/unit/harness-schedule.test.ts tests/unit/harness-gates.test.ts
# 15 passed
```

### Commit

`9b27308` — Resolve harness repo root when launchd cwd is /.

### Session learning

- Launchd trenchcoat jobs do not set WorkingDirectory; never trust `process.cwd()` for git checkouts.
- `~/.trenchcoat/runtime` has `package.json` but no `.git` — harness roots must require both.

---

## Iteration 4 — 2026-07-19 (hourly tick)

### Pipeline evaluation

Latest list-scan `list-scan-2026-07-19T21-05-49-776Z` complete (alpha purge, engagement path healthy). No new collector failures since iter-1 cap.

**Open (mostly awaiting live redeploy)**
| Issue | Impact | Evidence |
|-------|--------|----------|
| Iter-2 precheck still not live | wallet/chart/research ENOENT | err logs through 22:48 |
| Iter-3 harness REPO_ROOT not in live env | harness still broken until install | `grep TRENCHCOAT_REPO_ROOT ~/.trenchcoat/env` empty |
| Chat-report `status: running` after success | Operator recall wrong every scan | Latest chat-report.md |

### Highest-ROI patch chosen

**Finalize chat-report host `- status:` to `complete`/`failed` when the journal terminates.**

Rationale: Highest remaining in-repo ROI that does not require live install. Leaves ADR 006 seal-time per-run journals alone; fixes the consumer. Precheck/harness fixes already shipped earlier this loop.

**Deferred**
- Operator live redeploy (install-launchd) for iters 2–3
- Narrative-scan dark until runtime refresh
- Fomo `evaluate` probe

### Changes

| File | What |
|------|------|
| `src/orchestrator/chat-report.ts` | `finalizeChatReportRunStatus` |
| `src/orchestrator/run.ts` | Call on complete + failed |
| `docs/architecture/orchestrator.md`, `chat-agent.md` | Document mid-run promote + terminal rewrite |
| `tests/unit/chat-report.test.ts` | Rewrite + missing no-op |

### Risk assessment

| Risk | Blast radius | Mitigation |
|------|--------------|------------|
| Rewrites agent context | chat recall markdown | Replaces first `- status:` line only (host summary) |
| Missing report | none | No-op when file absent |
| Race with reader | low | Same paths already written mid-run; terminal rewrite is last host write |

**INVARIANTS:** INV-B2 (host-rendered recall stays host-owned); ADR 006 untouched (no sealed journal rewrite).

### Verification

```
pnpm exec vitest run tests/unit/chat-report.test.ts
# 16 passed
```

### Commit

`3536259` — Finalize chat-report status when the run journal terminates.

### Session learning

- Chat recall is promoted at alpha-purged (in-flight), not at terminal success — status must be finalized separately.

---

## Iteration 5 — 2026-07-19 (hourly tick) — STOP

### Pipeline evaluation

Latest list-scan `list-scan-2026-07-19T22-39-47-130Z` healthy: narrative read, 2/2 verified X likes, outbox broadcast, chat summary. No new in-repo failure modes since iters 1–4.

**Remaining pain is deploy lag, not missing code**
| Issue | Status |
|-------|--------|
| `run-precheck` → bare `run-with-lock-retry` | Fixed in repo (`659cdbf`); live bin still old → wallet/chart/research ENOENT |
| `TRENCHCOAT_REPO_ROOT` for harness | Fixed in repo (`9b27308`); live env unset |
| Chat-report terminal status | Fixed in repo (`3536259`); live runtime still shows `status: running` |
| Narrative-scan dark since 01:51 | Needs live runtime with legacy journal parse; no further code change identified |
| Fomo `probe:fomo evaluate` | Operator DX / gate scaffold; cron already overridden — not highest ROI vs deploy |

### Highest-ROI patch chosen

**None.** Further patches would either (a) re-touch already-shipped fixes, (b) require live `install-launchd` (forbidden this loop), or (c) expand Fomo probe scope without unblocking the social/wallet pipeline more than a redeploy would.

### Action

Killed the 1h loop (PID 66339). No commit this iteration.

### Operator next step (outside this loop)

Redeploy once (`ops/install-launchd.sh`) to activate iters 2–4 on the host. That clears precheck ENOENT, sets `TRENCHCOAT_REPO_ROOT`, and ships chat-status finalize + earlier snapshot cap if not already live.

### Session learning

- After a streak of host-wrapper / recall fixes, effectiveness loops should stop when live pain is only “repo ahead of runtime.”
