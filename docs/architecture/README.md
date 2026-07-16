---
description: Index of per-module architecture docs. Open the doc matching the module you are editing.
scope: project
status: active
last_verified: 2026-07-16
---

# Module docs

| Doc | Covers | Read before editing |
|---|---|---|
| [orchestrator.md](orchestrator.md) | Job registry, cron cycles, `@cursor/sdk` sessions, outbox → router, audit job | `src/orchestrator/`, `src/cli.ts`, `ops/` |
| [collectors.md](collectors.md) | Twitter scraping (burner acct), market-data clients, indicators incl. RSI, rate-limit gate, snapshot format | `src/collectors/`, `src/lib/` |
| [agent-workspace.md](agent-workspace.md) | The bot's instructions, skills, knowledge store, outbox, sandbox config | anything under `agent/` |
| [chat-agent.md](chat-agent.md) | Telegram bridge, session policy, on-demand research round-trip | `src/chat/`, `agent/skills/chat/` |

All modules are planning-stage: docs describe the target design and are the spec the
first implementation is written against. Update the doc in the same change if the
implementation diverges.
