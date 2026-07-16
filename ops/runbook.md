# Runbook

Deployment and operations for trenchcoat on macOS (launchd). Linux/cron
equivalents follow the same cadences.

## Layout on the host

```
~/.trenchcoat/
├── config.json            # operator config (docs/CONFIG.md)
├── env                    # mode 600, sourced by launchd plists (secrets)
├── browser-profile/       # Twitter burner auth (never in the repo)
├── telegram-session/      # GramJS session (never in the repo)
└── archive/               # host-side snapshot archive (docs/architecture/snapshot-archive.md)
```

## Scheduling

One plist per job from `ops/launchd/` (template: `com.trenchcoat.job.plist`),
plus a keepalive plist for the GramJS listener. Cadences (initial — tune here,
not in code):

| Job | Cadence |
|---|---|
| `chart-sweep` | hourly |
| `watchlist-scan` | every 2h |
| `list-scan` | every 4h |
| `narrative-scan` | every 6h |
| `research` | scheduler dequeues from the research queue, cap in config |
| `review` | daily 07:00 |
| `audit` | weekly Mon 06:00 |

Install: copy plist to `~/Library/LaunchAgents/`, fill in paths,
`launchctl load -w <plist>`. The listener plist sets `KeepAlive: true` —
recovery tier 1 (docs/architecture/orchestrator.md).

## Health checks

- `tc status` — last run per job, queue depth, lock state. A job whose last
  completed run is older than 3x its cadence is unhealthy.
- Listener health: the listener touches a heartbeat file every poll cycle;
  `tc status` flags a stale heartbeat (> 15 min). launchd restarts crashes;
  a silently wedged process is caught by the heartbeat and killed by
  the next `tc status --heal` (safe: alpha-queue appends are atomic per
  message, INV-Q1).

## Operator procedures

- **Twitter re-auth** — on a "needs headful re-auth" DM: `tc auth twitter`,
  complete the login interactively. Never scripted (documented exception,
  docs/INVARIANTS.md).
- **Exoneration review** — on a `warn` DM: reply `undock <id>` or
  `confirm <id>` in Telegram (or the CLI equivalents). No timeout — the
  penalty stays suspended and the adjacency counter already incremented.
- **Adding a Telegram channel** — add to `config.json` with `mode: "preview"`;
  if the first poll flags previews-disabled, switch to `"gramjs"` and restart
  the listener.
- **Adding a chain** — flow in docs/architecture/chains.md.
- **Failed-run triage** — tier 1 recovery is automatic. If DMed about a
  recovery-agent run, read `agent/reports/` diagnosis; state is already
  rolled back or repaired. Escalate to manual only on repeated same-job
  failures (the DM says so).

## Backups and retention

`agent/` is a git repo — state history is the backup (INV-S8); push to a
private remote weekly (launchd `com.trenchcoat.backup.plist`). The same job
incrementally encrypts and copies `~/.trenchcoat/archive/` sealed manifests,
structured records, and reachable blobs to the configured operator-controlled
backup, then verifies sampled hashes before recording backup time. Archive
garbage collection refuses to run when no verified backup exists.

Retention sweeps (workspace/failed inboxes 30d, host run folders 90d, chat
reports 30d) run inside `review`; hash-referenced decision/outcome/epoch/source
records remain. `state/` and `decisions.md` are never pruned.
