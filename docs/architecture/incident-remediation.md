---
description: Host-owned hourly/weekly incident remediation lane — detection, triage, gated mutation, Telegram approval, publish/deploy.
scope: project
status: active
last_verified: 2026-08-13
---

# Incident remediation

Separate from the weekly decision-policy harness (INV-S24) and Discord chain
integration (INV-S26). See [ADR 017](../adr/017-incident-remediation.md) and
[ADR 025](../adr/025-discord-suggestion-intake.md).

**Agent workspace lock:** `incident-remediate` / `incident-remediate-weekly` are
**not** agent-mutating jobs (INV-S15 / [ADR 027](../adr/027-improvement-lanes-skip-agent-lock.md)).
They never take `agent/.lock`, so continuous scans cannot starve the lane.
Confinement is remediations/ locks + repo mutation lock; rare post-fix
claim-index writes take a brief agent lock only for that mutation.

## Flow

1. **Scan** — bounded deltas: health snapshot **findings** (cadence/heartbeat/stuck-run/systemd), skip journals, structured `/tmp/trenchcoat.*.{out,err}.log` lines (inode/size cursors), and passive Discord suggestion threads when `discord_suggestions.enabled`.
   The host drops log/health/skip candidates when every mapped job is healthy (`already-recovered`).
   A terminal fingerprint reopens only when a mapped job is degraded.
   Log prompts use a bounded `evidence-log.txt` snapshot.
2. **Fingerprint** — stable id from job/error-class/component/target (not raw
   timestamps/text). Log lines without a JSON `job` inherit the log stem
   (`trenchcoat.x-scan.err.log` → `list-scan`). Evidence stored as untrusted envelopes; prompts get paths only.
3. **Triage** — `composer-2.5-fast` → `ignore | attention-now | defer-weekly`.
   Host may downgrade `attention-now`, never upgrade past evidence floors.
   Discord suggestions enter already-triaged as `attention-now` after host gates.
4. **Immediate** — the host re-checks live health before diagnose.
   It ignores `already-recovered` (Discord suggestions skip this floor).
   It deletes leftover `diff-summary.json` / `gate.json` / `post-review.json`.
   Then diagnose → propose → pre-review → risk/approval → build in
   isolated worktree → post-diff review → **`pnpm install --frozen-lockfile`**
   (sibling worktrees do not inherit `node_modules`) → gates (`typecheck` /
   `lint` / `test:all`) → ff-only push →
   deploy via `install-systemd.sh` on Linux or `install-launchd.sh` on macOS →
   smoke → revert+`runtime.prev` on failure. Diagnose/propose/review
   Cursor sessions use **ask** mode ([ADR 029](../adr/029-remediation-propose-ask-mode.md));
   gate command `detail` keeps the **tail** of output so vitest failure summaries
   survive the 1k truncation.
   diagnose/propose may return typed `not-viable` (host closes the incident).
   Distinguish `propose:session failed` (infra) from `pre-review-reject` (product).
   On pre-review `revise`, the host re-enters propose with `priorPreReviewPath` up
   to `max_pre_review_revises` (default 5) before `pre-review-revise-exhausted`
   fails the incident for operator attention. `reject` fails on the first decision.
   Each revise round archives `proposal.revise-N.json` and `pre-review.revise-N.json`.
   Verbose `invariants`/`smokeChecks` labels are host-truncated to 64 chars.
5. **Weekly** — Monday 08:00 local; revalidate deferred queue; at most one item.
6. **Post-fix claim audit (INV-S28)** — after deploy health/smoke, set an
   integrity hold on affected jobs; wait for configured healthy source
   observations from the deployed commit; revalidate typed market claims in the
   conservative impact window; append-only supersede invalidated state; stage
   one destination-aware `finding.correction` per incident (no harness/canary).
   Skip the wait when no affected source kind appears in the ledger. Release the
   hold on `attention-required`, `failed`, and `completed`.

## Discord suggestions (schema 17)

Passive conversation-aware intake (`incident_remediation.discord_suggestions`):

| Field | Default | Role |
| --- | --- | --- |
| `enabled` | `false` | Master switch (also requires parent `enabled`) |
| `channel_ids` | `[]` | Empty → use `chat.discord.channel_ids` |
| `classifier_model` | `composer-2.5-fast` | Batch thread classifier |
| `max_new_incidents_per_scan` | `3` | Cap newly queued suggestion incidents |
| `max_active_suggestion_incidents` | `1` | Concurrent suggestion-origin active cap |
| `forming_ttl_days` | `7` | Idle expiry for incomplete ideas |
| `max_forming_rounds` | `5` | Max re-form attempts before not-buildable |
| `ambient_thread_gap_ms` | `300000` | Non-reply messages within this gap share a thread |
| `min_confidence` | `0.7` | Below → downgrade to `forming` |
| `followup_enabled` | `true` | One clarifying question per forming suggestion (schema 24) |

Unit of analysis is a **thread** (reply chain + ambient window), not a single
message. Bot/webhook messages are context-only. Reply ancestors may extend
context beyond the scan window. Early fingerprint dedupe runs before the model;
extensions of previously **built** suggestions proceed as `extends:`.

Admission needs **both** a request word and a product-surface word in human
text (`hasSuggestionSignal`); a bare mention admits nothing. A formed
suggestion must carry `symptom`, `intendedBehavior`, and one to five measurable
`acceptanceCriteria` (`checkFormedContract`). A missing intended behavior
downgrades to `forming`; a missing symptom, a bad criteria count, an
unmeasurable criterion, or alternatives without a rationale becomes
`classifier-failed`. The daily Telegram digest details `queued`,
`queued-waiting`, and `built` only, and collapses forming threads into one
count; a forming-only day sends no digest. Ledger:
`~/.trenchcoat/remediations/suggestions.json`. CLI: `tc remediations suggestions`.

On the first `forming` round the scan posts **one** clarifying question in the
thread, as a reply to the last human message in the window
(`maybePostSuggestionFollowup`). This stops a clear complaint with a vague fix
from expiring in silence. `renderSuggestionFollowup` owns the text: a fixed
prefix plus the classifier `followupQuestion` with links, mentions, markdown,
and secrets stripped, capped at 280 characters. Text without a question mark
gets a fixed fallback question. `followupMessageId` / `followupAskedAt` in the
ledger keep it to one question per entry, and a send failure writes no field, so
the next scan retries. Set `followup_enabled: false` to stay silent on Discord.
Telegram digests / failure alerts /
high-risk approval cards use host-composed plain-language copy (optionally
polished by `composer-2.5` in an assistant voice); approval cards always end
with exact `approve|defer|reject remediation rem-…` lines. Host normalizes
Telegram typos (`Rem 92da…` → `rem-92da…`) so approvals apply before chat
([ADR 030](../adr/030-host-authoritative-remediation-approvals.md)).
Raw Discord text never enters the message.

## Post-fix revalidation

Config under `incident_remediation.revalidation` (schema 14):

| Field | Default | Role |
| --- | --- | --- |
| `enabled` | `true` | Off only when parent lane needs deploy-without-audit; parent `enabled=false` still disables all |
| `required_healthy_observations` | `2` | Distinct healthy post-deploy observations per affected source |
| `max_rounds` | `3` | Inconclusive retry cap |
| `max_wait_hours` | `24` | Max wait for recovery / inconclusive exhaustion |
| `evaluate_model` / `review_model` | `composer-2.5-fast` | Unanimous invalidation gate |
| `auto_correct` | `true` | Stage public corrections after reconcile |

Phases after `deployed`: `awaiting-recovery-data` → collect/revalidate →
`reconciling-state` → `correcting` → `completed` (or `attention-required`).
Unknown impact window / unknown market-affecting paths → operator alert, no
automatic correction. Historical manual FYP corrections are not backfilled.
The integrity hold blocks broadcasts from affected jobs during the wait.
`attention-required` and `tc remediations fail` release that hold.
The host still does not complete without recovery proof (INV-S28).
A source kind with no ledger rows cannot prove recovery.
When every affected source kind is missing, the audit goes to
`attention-required` at once.

## Risk

| Level | Rule |
| --- | --- |
| low | collectors / ordinary orchestrator+lib / matching tests+docs; ≤8 files, ≤400 lines |
| high | config/migrations, auth/sandbox/prompts/chat/router, security/integrity, harness/deploy/locks, deps, oversized diffs — Telegram approval with proposal hash |
| deny | secrets, `.env`, `src/remediation/**`, `agent/`, `archive/`, destructive git, gate weakening |

## Operator surface

- Telegram: `approve|defer|reject remediation rem-<id>` (hyphen required; host
  also accepts `Rem <hex>` typos), `/remediations`, `remediation <id>`
- CLI: `tc remediations scan|run|status|approve|defer|reject|retry|fail`
- Config: `incident_remediation.enabled` + `schedule_enabled` (both default false);
  post-fix audit via nested `revalidation` (schema 14, INV-S28);
  `max_pre_review_revises` (default 5)

### Repo root and deploy (VPS)

- `tc remediations *` picks `repoRoot` as `cwd` when `ops/install-launchd.sh`
  exists there, else `TRENCHCOAT_REPO_ROOT`. On the VPS always run from the
  main checkout (`~/src/trenchcoat`) or set `TRENCHCOAT_REPO_ROOT` to that path.
  A rem worktree also contains `ops/install-launchd.sh`. If cwd is the worktree,
  publish calls `assertCleanMain` there and fails with `wrong-branch`.
- Deploy and rollback install use `resolveHostInstallScript`
  (`src/harness/deploy.ts`): `ops/install-systemd.sh` on Linux,
  `ops/install-launchd.sh` on macOS. Do not call launchd install on the VPS.
- Patches under `src/collectors/market/**` mark DexScreener/CoinGecko impact.
  After deploy the incident stays `awaiting-recovery-data` until
  `required_healthy_observations` post-deploy healthy source proofs exist
  (or `max_wait_hours` / attention). That holds `activeIncidentId` and blocks
  other remediations (`max_active=1`). When no affected source kind has ledger
  rows, the audit skips that wait. It goes to `attention-required` and
  releases the hold.

## Serialization

Shares `~/.trenchcoat/repo-mutation.lock` with chain-integration publish and
harness local fast-forward so writers cannot race.
