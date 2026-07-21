---
description: ADR — Host-owned hourly incident remediation with Telegram high-risk approval and a separate weekly deferred pass; weekly decision-policy harness unchanged.
scope: project
status: accepted
last_verified: 2026-07-21
---

# ADR 017 — Hourly incident remediation lane

## Context

Operational regressions (empty scrapes, FOMO enqueue noise, deploy/health
drift) were diagnosed manually in operator chats. The weekly harness
(INV-S24) must stay decision-policy only. Discord chain integration
(INV-S26) is a different mutation class. Neither should absorb unbounded
ops repair.

## Decision

- Add a **host-owned** remediation lane under `src/remediation/` with durable
  state in `~/.trenchcoat/remediations/`.
- Hourly job `incident-remediate` scans bounded health/log/skip deltas,
  sanitizes untrusted evidence, fingerprints stably, and triages with
  `composer-2.5-fast` (host may only downgrade `attention-now`).
- Immediate path: diagnose → propose (`cursor-grok-4.5-high`) → pre-review →
  risk gate → build → actual-diff review → secret/typecheck/lint/`test:all` →
  ff-only publish under `repo-mutation.lock` → deploy + smoke → rollback on
  failure.
- Low-risk auto-proceeds inside allowlisted collector/orchestrator/lib/tests/docs
  paths (with size bounds). High-risk requires Telegram approval for the exact
  proposal hash. Absolute-deny surfaces cannot be overridden.
- Weekly job `incident-remediate-weekly` (Monday 08:00 local) processes at most
  one revalidated deferred incident — **never** into the policy harness prompt.
- Config schema **13** adds `incident_remediation` defaulting
  `enabled=false` and `schedule_enabled=false`.
- Harness integrate/deploy acquires the shared mutation lock; cadence/models/
  POLICY_ALLOWLIST/holdout/canary/no-origin-push unchanged.

## Alternatives considered

- **Widen INV-S24** — rejected; policy confinement must stay narrow.
- **Let models choose shell/git/deploy** — rejected; fail-closed host gates only.
- **Feed deferred ops into harness planner** — rejected; separate weekly pass.

## Consequences

- New INV-S27. Operators must enable flags deliberately after dry canary.
- Schema 13 must stay aligned across ConfigSchema, DEPLOYMENT_CONFIG_SCHEMA,
  and `install-launchd.sh`.

## References

- [architecture/incident-remediation.md](../architecture/incident-remediation.md)
- INV-S24 / INV-S26 / INV-S27 in [INVARIANTS.md](../INVARIANTS.md)
