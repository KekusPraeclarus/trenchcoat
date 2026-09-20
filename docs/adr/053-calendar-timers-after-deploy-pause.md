---
title: "053 — Calendar timers after deploy pause"
status: accepted
date: 2026-09-17
last_verified: 2026-09-17
---

# ADR 053: Calendar timers after deploy pause

## Context

Deploy pause stops every scheduled systemd timer. An `OnUnitActiveSec` timer
then shows `Trigger: n/a`. It stays dead until something starts the service.

`narrative-source-review` and `fomo-narrative-source-scan` used that interval
form. They missed days after each VPS deploy.

A calendar timer with `Persistent=true` catch-up starts the job as soon as
the timer starts. If install starts the timer while `deploy-pause.json` still
exists, the job defers. A later blocking `systemctl start` of that oneshot
holds the installer on workspace-lock retries.

## Decision

1. `fomo-narrative-source-scan` uses `OnCalendar=*-*-* 00,06,12,18:00:00`.
2. `narrative-source-review` uses `OnCalendar=*-*-* 19:00:00`.
3. Both timers set `Persistent=true`.
4. `install-systemd.sh` enables timer units during pause. It starts them
   only after it removes the pause file.
5. Deferred oneshot kicks use `systemctl --user --no-block start`.

## Consequences

- Review keeps a fixed 19:00 UTC wall clock. Catch-up does not shift it.
- A missed slot runs once after pause clears.
- A deploy after 19:00 UTC still catch-up runs review that day.
- Install no longer waits on a long scan or review oneshot.
- Interval jobs still use `OnUnitActiveSec`. They need
  `start_scheduled_timers` after each deploy.

## Alternatives considered

- Keep a 86400s interval for review. Rejected. Catch-up shifts the next
  fire off 19:00 UTC. A stop still leaves `Trigger: n/a` until a start.
- Restart timers during pause. Rejected. Persistent catch-up runs under
  pause and wedges install.
- Block on deferred `systemctl start`. Rejected. Scan lock retries hold
  the whole deploy.

## Related

- Cadences: [orchestrator.md](../architecture/orchestrator.md)
- Install order: [harness-improvement.md](../architecture/harness-improvement.md)
- Operator timers: [../../ops/runbook.md](../../ops/runbook.md)
