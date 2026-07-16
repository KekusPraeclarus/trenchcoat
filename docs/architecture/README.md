---
description: Index of per-module architecture docs. Open the doc matching the module you are editing.
scope: project
status: active
last_verified: 2026-07-16
---

# Module docs

| Doc | Covers | Read before editing |
|---|---|---|
| [orchestrator.md](orchestrator.md) | Job definitions, run loop, `@cursor/sdk` session handling, scheduling | `src/orchestrator/`, `src/cli.ts`, `ops/` |
| [collectors.md](collectors.md) | Twitter scraping, market-data clients, rate-limit gate, snapshot format | `src/collectors/`, `src/lib/` |
| [agent-workspace.md](agent-workspace.md) | The bot's instructions, skills, state schema, sandbox config | anything under `agent/` |

All modules are planning-stage: docs describe the target design and are the spec the
first implementation is written against. Update the doc in the same change if the
implementation diverges.
