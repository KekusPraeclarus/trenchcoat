---
description: Chat agent module - Telegram bridge to a minimal orchestrator session that spawns research sub-agents, keeping the conversational context window small.
scope: module
status: draft
last_verified: 2026-07-16
read_when:
  - Editing src/chat/ or the agent's chat / deep-research skills.
  - Changing how conversations trigger research or how replies leave the machine.
---

# Chat agent

## Purpose

The operator's conversational window into everything the bot knows: discuss
findings, probe research that never met the broadcast bar, and ask for an opinion
on any token — answered by combining stored knowledge with fresh on-demand
research. Distinct from broadcasts (outbound, via the external router); this is
inbound, interactive, operator-only.

## Minimal-orchestrator pattern

The conversational session must survive long chats without bloating, so it does as
little as possible itself:

- **Chat session** (`skills/chat/`) — resumable via `Agent.resume` within a
  conversation. Holds only: the conversation, `INDEX.md`, and sub-agent reports.
  It answers directly when the index and its existing context suffice (recall
  questions, follow-ups on a report it already has). For anything heavier it
  writes a research request and waits.
- **Research sub-agent** (`skills/deep-research/`) — a fresh one-shot
  `Agent.prompt` session over the same workspace, spawned by the chat service per
  request. It does the expensive work: walks the knowledge store, reads research
  bodies and decision history, incorporates any fresh collector snapshots, and
  writes a compact report to `reports/chat/<conv-id>-<n>.md`. Then it's gone —
  its burned context never touches the chat session.
- The chat session reads the report and answers. Deep follow-ups spawn another
  sub-agent; the reports accumulate as the conversation's working set.

This is the same economics as the cron jobs: disposable heavy contexts, one small
durable thread.

## Design

- `src/chat/` runs a Telegram bot (long-polling — no inbound port) bridging
  messages to the chat session (cwd = `agent/`, sandboxed, no network)
- **Operator-only**: messages accepted from an allowlisted Telegram user id;
  everything else dropped unanswered (INV-B3)
- **Fresh research round-trip**: the sub-agent cannot fetch; when the request
  needs live data ("look at $TOKEN fresh"), the chat service runs the matching
  collectors first (same rate-limit gate, INV-R4), drops snapshots into a
  conversation inbox, then spawns the sub-agent over them
- **Session policy**: fresh chat session per conversation, resumed within it,
  closed after an idle timeout. The knowledge store is the long-term memory;
  sessions stay disposable
- Replies are plain text through the bot; long answers reference the sub-agent
  report rather than dumping it into chat

## Token-burn notes

- The chat session never greps research bodies itself — that's the sub-agent's job
- Recall questions are answered from the store without collectors; fresh data is
  fetched only when the question needs it
- Sub-agent reports are capped in size by the deep-research skill's output contract

## Source files to inspect before editing (once implemented)

- `src/chat/bot.ts` — telegram long-polling, allowlist, message loop
- `src/chat/session.ts` — chat session lifecycle
- `src/chat/subagent.ts` — research request handling, collector round-trip,
  sub-agent spawning
- `agent/skills/chat/SKILL.md` and `agent/skills/deep-research/SKILL.md`

## Gotchas and security-sensitive boundaries

- The Telegram bot token lives in the chat service env, never under `agent/`
  (INV-I3)
- Inbound chat text is operator-authored but still crosses into the sandbox —
  deliver it as the session prompt, never write it into the knowledge store
  verbatim without attribution
- Sub-agent research round-trips go through the orchestrator's collector layer and
  rate gate; the chat service never fetches upstream APIs directly (INV-R4)
- Replies can contain knowledge-store content that originated in tweets or alpha
  channels — fine for the operator, but the chat service must never echo content
  to any chat id outside the allowlist (INV-B3)
