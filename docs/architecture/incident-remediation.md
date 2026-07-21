---
description: Host-owned hourly/weekly incident remediation lane — detection, triage, gated mutation, Telegram approval, publish/deploy.
scope: project
status: active
last_verified: 2026-07-21
---

# Incident remediation

Separate from the weekly decision-policy harness (INV-S24) and Discord chain
integration (INV-S26). See [ADR 017](../adr/017-incident-remediation.md).

## Flow

1. **Scan** — bounded deltas: health snapshot, skip journals, structured
   `/tmp/trenchcoat.*.{out,err}.log` lines (inode/size cursors).
2. **Fingerprint** — stable id from job/error-class/component/target (not raw
   timestamps/text). Evidence stored as untrusted envelopes; prompts get paths only.
3. **Triage** — `composer-2.5-fast` → `ignore | attention-now | defer-weekly`.
   Host may downgrade `attention-now`, never upgrade past evidence floors.
4. **Immediate** — diagnose → propose → pre-review → risk/approval → build in
   isolated worktree → post-diff review → gates (`test:all`) → ff-only push →
   deploy → smoke → revert+`runtime.prev` on failure.
5. **Weekly** — Monday 08:00 local; revalidate deferred queue; at most one item.
6. **Post-fix claim audit (INV-S28)** — after deploy health/smoke, set an
   integrity hold on affected jobs; wait for configured healthy source
   observations from the deployed commit; revalidate typed market claims in the
   conservative impact window; append-only supersede invalidated state; stage
   one destination-aware `finding.correction` per incident (no harness/canary).

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

## Risk

| Level | Rule |
| --- | --- |
| low | collectors / ordinary orchestrator+lib / matching tests+docs; ≤8 files, ≤400 lines |
| high | config/migrations, auth/sandbox/prompts/chat/router, security/integrity, harness/deploy/locks, deps, oversized diffs — Telegram approval with proposal hash |
| deny | secrets, `.env`, `src/remediation/**`, `agent/`, `archive/`, destructive git, gate weakening |

## Operator surface

- Telegram: `approve|defer|reject remediation <id>`, `/remediations`, `remediation <id>`
- CLI: `tc remediations scan|run|status|approve|defer|reject|retry|fail`
- Config: `incident_remediation.enabled` + `schedule_enabled` (both default false);
  post-fix audit via nested `revalidation` (schema 14, INV-S28)

## Serialization

Shares `~/.trenchcoat/repo-mutation.lock` with chain-integration publish and
harness local fast-forward so writers cannot race.
