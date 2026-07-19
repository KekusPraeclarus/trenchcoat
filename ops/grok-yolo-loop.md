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

`4bdd6f8` — Cap collector snapshot envelopes at 500 items to prevent list-scan failures.
