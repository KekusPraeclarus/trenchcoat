---
description: ADR — Discord channel conversation over main workspace; addressing gate; unconfirmed research + synthesis; research caps removed.
scope: project
status: accepted
last_verified: 2026-07-21
---

# ADR 022 — Discord conversational agent

## Context

Guild members wanted Telegram-style conversation with the Discord research bot
in its dedicated channel: ask questions against current knowledge, compare
tokens, and get deep research without a confirm/cancel step. Today Discord only
had regex CA research, idea-tracking (@mention), and passive watch renew.

Constraints that shaped the design:

- INV-D1 isolates Discord research under `~/.trenchcoat/discord/**`, but
  “use all available info” requires the main agent knowledge store.
- The channel is bot-dedicated yet still hosts member-to-member chatter — the
  bot must not jump into every message.
- “No research limits” meant Discord intake quotas, not the main cron
  `research.daily_cap` or tracking / chain-integration safety caps.
- Attacker-controlled channel text must not unbounded-enqueue research or
  control mentions/delivery.

## Decision

1. **Conversation surface (opt-in).** `chat.discord.conversation.enabled`
   (default false). Ask-mode Cursor sessions with cwd = main agent root
   (`mainAgentRoot()`), lock-free reads, instruction integrity per turn. Skill
   `agent/skills/discord-chat/SKILL.md`. Classifier/research runners stay on the
   Discord isolated workspace.

2. **Fourth INV-D1 host exception.** Conversation turns never hold the main
   writer lock and never mutate state. Host may copy a validated Discord
   research chat report into main `agent/reports/chat/discord-<runId>.md` under
   the writer lock so synthesis can path-reference it.

3. **Addressing gate (INV-D9).** After renew / watch-expiry / research regex /
   tracking: always-addressed on @mention or reply-to-bot (tracking `none`
   falls through; tracking store unreadable also falls through as `ignored`;
   tracking `failed` does not). Deterministic silence for
   reply-to-other-member and non-alphanumeric content. Else fail-closed
   classifier (`CONVERSATION_GATE_PROMPT`, path-only snapshot). Parse/session
   error → silent.

4. **Unconfirmed research + one-hop synthesis.** Model may emit one fenced
   `{"research":[...]}` block; host validates subjects against chain/CA/ticker
   grammar, caps at `max_research_per_turn` (injection bound, not a quota),
   enqueues `origin: "conversation"`. Silent pump (no raw research reply);
   when all linked requests are terminal, synthesis resumes the channel session
   and answers the original question. Synthesis output cannot re-enqueue
   research.

5. **Remove Discord research caps (schema 16).** Delete
   `per_user_daily_cap`, `server_daily_cap`, `max_active_per_user` from
   `chat.discord`. Keep FIFO `.worker.lock`, tracking
   `max_active_per_user` (INV-D4), and chain-integration attempt caps.

6. **Proactive watch expiry.** Mirror idea-tracking: after `watch_days`, send
   one bundled notice; yes/no regex scoped to notice owner;
   `watch_expiry_reply_window_days` (default 7). Passive renew-on-research-anchor
   path unchanged.

## Consequences

- Channel members can ask operator-level knowledge questions once conversation
  is enabled — treat channel membership as the trust boundary.
- Main workspace stays secret-free (INV-I3); conversation is ask-mode only.
- No Discord daily research quota; structural single-runner FIFO remains.
- Architecture: [discord-conversation.md](../architecture/discord-conversation.md).
  Invariants: INV-D1 (fourth exception), INV-D9, INV-S15 (report-copy writer).

## Alternatives considered

- Conversation over Discord-isolated workspace only → rejected; incomplete
  knowledge vs the product ask.
- Require confirm/cancel like Telegram → rejected; Discord already queues
  research without confirm for CA intake.
- Remove main `research.daily_cap` with Discord caps → rejected; cron lane is
  separate.
- Unbounded model-controlled research enqueue → rejected; `max_research_per_turn`
  is an injection bound.
- Always reply in the dedicated channel (no gate) → rejected; member chatter
  must stay silent.

## References

- [architecture/discord-conversation.md](../architecture/discord-conversation.md)
- [architecture/discord-research.md](../architecture/discord-research.md)
- [architecture/chat-agent.md](../architecture/chat-agent.md)
- Amends ADR 010 (removes Discord research intake caps); ADR 012, ADR 018, ADR 019
- INV-D1 (fourth host exception), INV-D9, INV-S15
