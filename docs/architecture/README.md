---
description: Index of per-module architecture docs. Open the doc matching the module you are editing.
scope: project
status: active
last_verified: 2026-07-16
---

# Module docs

| Doc | Covers | Read before editing |
|---|---|---|
| [orchestrator.md](orchestrator.md) | Job registry, cron cycles, `@cursor/sdk` sessions, outbox → router (urgent bypass), alpha-queue lifecycle, audit + ledger + source scoring, rug-dock, recovery ladder | `src/orchestrator/`, `src/cli.ts`, `ops/` |
| [collectors.md](collectors.md) | Twitter scraping (burner acct), Telegram ingestion (preview poller + GramJS), market-data clients, security gate, new-pool feed, indicators incl. RSI, rate-limit gate, snapshot/provenance format | `src/collectors/`, `src/lib/` |
| [agent-workspace.md](agent-workspace.md) | The bot's instructions, skills, knowledge store (index, research, narratives, sources), decision weighting, outbox, sandbox config | anything under `agent/` |
| [chat-agent.md](chat-agent.md) | Telegram bridge, minimal-orchestrator pattern, research sub-agents | `src/chat/`, `agent/skills/chat/`, `agent/skills/deep-research/` |

All modules are planning-stage: docs describe the target design and are the spec the
first implementation is written against. Update the doc in the same change if the
implementation diverges.
