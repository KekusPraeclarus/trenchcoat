---
description: Chat agent module - Telegram bridge to a conversational cursor-sdk session over the shared workspace, with on-demand research.
scope: module
status: draft
last_verified: 2026-07-16
read_when:
  - Editing src/chat/ or the agent's chat skill.
  - Changing how conversations trigger research or how replies leave the machine.
---

# Chat agent

## Purpose

The operator's conversational window into everything the bot knows: discuss
findings, probe research that never met the broadcast bar, and ask for an opinion
on any token — answered by combining stored knowledge with fresh on-demand
research. Distinct from broadcasts (outbound, via the external router); this is
inbound, interactive, operator-only.

## Design

- `src/chat/` runs a Telegram bot (long-polling — no inbound port) and bridges
  messages to a cursor-sdk session with `cwd = agent/` — the same sandboxed
  workspace and knowledge store the cron jobs use, loaded with `skills/chat/`.
- **Session policy**: fresh `Agent.create` per conversation, resumed via
  `Agent.resume` within it (multi-turn context), closed after an idle timeout. The
  knowledge store is the long-term memory; sessions stay disposable. (Leaning
  confirmed in TECHNICAL-SPEC open questions; revisit if conversations feel
  amnesiac.)
- **Operator-only**: messages are accepted from an allowlisted Telegram user id;
  everything else is dropped unanswered.
- **On-demand research**: the sandboxed session cannot reach the network, so "look
  at $TOKEN fresh" works by request file — the session writes a research request,
  the chat service runs the matching collectors (same rate-limit gate), drops
  snapshots into a conversation inbox, and resumes the session. One round-trip,
  invisible to the operator beyond a "digging…" latency.
- Replies are plain text back through the bot; long answers reference the report
  the bot wrote rather than dumping the knowledge store into chat.

## Token-burn notes

- The chat skill instructs index-first retrieval (INDEX.md → frontmatter → body on
  match), identical to job sessions
- Fresh research is fetched only when the question needs it — recall questions are
  answered from the store without collectors

## Source files to inspect before editing (once implemented)

- `src/chat/bot.ts` — telegram long-polling, allowlist, message loop
- `src/chat/session.ts` — sdk session lifecycle, research round-trip
- `agent/skills/chat/SKILL.md` — the conversational behaviour itself

## Gotchas and security-sensitive boundaries

- The Telegram bot token lives in the chat service env, never under `agent/`
  (INV-I3)
- Inbound chat text is operator-authored but still crosses into the sandbox —
  deliver it as the session prompt, never write it into the knowledge store
  verbatim without attribution
- The research round-trip must go through the orchestrator's collector layer and
  rate gate; the chat service never fetches upstream APIs directly (INV-R1)
- Replies can contain knowledge-store content that originated in tweets — fine for
  the operator, but the chat service must never echo content to any chat id
  outside the allowlist (INV-B3)
