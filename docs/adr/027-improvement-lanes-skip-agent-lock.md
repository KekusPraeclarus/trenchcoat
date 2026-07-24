---
title: "027 — Improvement lanes skip the agent workspace lock"
status: accepted
date: 2026-07-23
---

# ADR 027: Improvement lanes skip the agent workspace lock

## Context

Continuous agent-mutating jobs (`list-scan`, wallet scans, research, etc.) hold
`agent/.lock` for long stretches. After Discord suggestion intake (ADR 025) and
incident remediation (ADR 017) were enabled, the hourly `incident-remediate`
timer almost always exited 3 (`workspace lock held`) and never advanced the
suggestion queue. Diagnose could succeed, but propose/build rarely got a turn.
The weekly `harness-improve` lane has the same starvation risk.

INV-S15 requires one writer for **agent state**, not that every host cron must
hold that lock for LLM sessions that only touch remediations/, harness
worktrees, or git under the repo mutation lock.

## Decision

1. Treat `harness-improve`, `harness-meta-improve`, `incident-remediate`, and
   `incident-remediate-weekly` as **agent-lock exempt** (`AGENT_LOCK_EXEMPT_JOBS` /
   `jobRequiresAgentWorkspaceLock`).
2. Those jobs never acquire `agent/.lock` in `runJob`. They keep their own
   confinement: remediations/ locks, harness worktrees, and
   `repo-mutation.lock` for publish/integrate.
3. Improvement runs write journals/reports under the archive (no agent journal
   mirror, no agent retention prune) so they do not contend on `agent/reports`.
4. Rare post-fix claim-index writes into agent state use a **brief**
   `withAgentWorkspaceLock` only for that mutation, with retries — not a
   full-job hold.
5. Deploy pause still applies (exit 3); `run-with-lock-retry` remains useful for
   pause, not for agent-lock contention on these jobs.

## Consequences

- Continuous scans can no longer starve remediation or harness improvement.
- INV-S15 documents the exemption and cites this ADR.
- Live operators must redeploy before hourly remediations stop failing on lock.
- Post-fix agent writes may still wait briefly if a scan holds the lock; that
  is preferred to holding the lock for multi-minute Cursor sessions.

## Alternatives considered

- Longer lock-retry budgets for remediations — still loses to multi-hour scans.
- Separate process + always-on remediation daemon — more ops surface than needed.
- Dropping agent lock for all host-only jobs — too broad; many host-only jobs
  still prune or migrate agent trees.

## Follow-ups

- After deploy: `tc remediations retry` for failed suggestion incidents and
  `tc remediations scan|run` to admit `queued-waiting` capacity backlog.
- Wallet settle/scan/review brief-lock + paper ledger finalisation →
  [ADR 031](031-wallet-settle-brief-locks-and-ledger.md) (extends this pattern;
  not a blanket host-only exemption).
