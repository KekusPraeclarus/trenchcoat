---
description: Discord conversational agent — addressing gate, ask-mode session over main workspace, agent-triggered research with synthesis.
scope: module
status: active
last_verified: 2026-08-12
read_when:
  - Editing src/discord/conversation*.ts, src/discord/live-tape.ts, or skills/discord-chat.
  - Changing Discord channel message routing after research/tracking.
---

# Discord conversation

Community chat in configured Discord research channels (ADR 022). Complements
[discord-research.md](discord-research.md) (CA/regex research) and
[discord-tracking.md](discord-tracking.md) (idea tracking). Telegram operator
chat remains separate ([chat-agent.md](chat-agent.md)).

## Product contract

- Opt-in via `chat.discord.conversation.enabled` (default false)
- Channels: `conversation.channel_ids` when non-empty, else all `chat.discord.channel_ids`
- No DMs — guild+channel scoped only
- Read-only ask-mode session over the **main** agent workspace (`~/.trenchcoat/agent`)
- Research triggers without confirmation; synthesis answers the original question
- Addressing gate stays silent unless spoken to (INV-D9)

## Routing order

1. Passive renew / keep watching (reply to research anchor)
2. Reply to watch-expiry notice (deterministic yes/no)
3. Research / chain-integration regex
4. @mention or reply-to-bot → tracking classifier; `none` falls through to conversation; tracking store unreadable also falls through as `ignored`; classifier/`failed` stops
5. Addressing gate (pre-filters + fail-closed classifier) → conversation turn

## Addressing gate

- Always addressed: @mention or reply-to-bot (after tracking `none`)
- Never addressed: reply to another member without mention; no alphanumeric content
- Else: `composer-2.5-fast` classifier over Discord agent workspace, path-only snapshot
  (`CONVERSATION_GATE_PROMPT`). Parse failure / session error → silent
- In-memory per-channel context ring (`context_messages`, default 10)

## Session

- Per-channel Cursor chat id in `~/.trenchcoat/discord/conversation-sessions.json`
- Idle rotation: `idle_timeout_minutes` (default 30)
- Per-channel mutex; typing indicator once per turn; no draft streaming
- Skill: `agent/skills/discord-chat/SKILL.md`
- Integrity assert over main workspace each turn; no writer lock (INV-S15 lock-free reads)
- Replies never narrate host mechanics (skills, INDEX, paths); conversational
  acknowledgments/corrections are allowed. Path-scrubbed, empty allowed-mentions,
  chunked via `splitDiscordText`

## Live market tape (CA turns)

- One validated CA per turn via shared extraction (`chainCaTokensInText` /
  `parseChainCa` / bare CA + chain hint) and `validateConversationResearchSubject`
- Host DexScreener prefetch before the ask-mode runner (INV-R1 gated fetch)
- Pair selection matches collect-observation (chain id + base token address find;
  never liquidity rank)
- Trusted metric lines inject into `buildDiscordConversationPrompt`
- Fetch error fails closed: soft note only; no invented numbers
- When tape status is ok, the host prompt overrides the discord-chat skill
  knowledge-store-only rule for current market numbers
- Synthesis path does not prefetch; it stays report-path synthesis only

## Research hand-off

- Model may end with one fenced `{"research":[...]}` block (≤ `max_research_per_turn`)
- Host validates subjects against chain/CA/ticker grammar; invalid dropped
- Enqueued as `origin: "conversation"` with synthetic `requestId` `conv-<messageId>-<n>`
- Silent pump path (no research reply); watch subscribe / main promote unchanged
- Host copies validated Discord chat reports into main `reports/chat/discord-<runId>.md`
  under the main writer lock
- When all linked requests are terminal → synthesis turn (no nested research enqueue)
- Crash: synthesizing lease 15m reclaim; conversations pruned at 35 days

## Config (`chat.discord.conversation`)

| Key | Default | Notes |
|---|---|---|
| `enabled` | false | Rollout flip |
| `model` | composer-2.5 | Conversation turns |
| `classifier_model` | composer-2.5-fast | Addressing gate |
| `idle_timeout_minutes` | 30 | Session rotation |
| `context_messages` | 10 | Gate ring buffer |
| `channel_ids` | [] | Empty → all research channels |
| `max_research_per_turn` | 5 | Injection bound, not a quota |

Also: `chat.discord.watch_expiry_reply_window_days` (default 7) for proactive watch renewal.

## Suggestion intake (passive)

A separate hourly path under incident remediation (ADR 025) may passively scan
configured Discord channels for buildable product suggestions. It is not the
conversational agent: no addressing gate, no replies, no reactions. Conversation
threads (including bot/webhook context and reply-chain ancestors) are evidence
only. See [incident-remediation.md](incident-remediation.md).

## Broadcast feedback reactions (passive)

The same Gateway bot also watches reactions on delivered broadcasts. It reads
`👍` and `👎` from the operator only, in the configured feedback channel only.
This path sends no Discord reply. It needs the `GuildMessageReactions` intent
plus the `Message` and `Reaction` partials, and the bot needs View Channel,
Read Message History, and Add Reactions in that channel. See
[broadcast-feedback.md](broadcast-feedback.md).

## References

- ADR 022 — Discord conversational agent
- ADR 043 — Operator broadcast feedback
- INV-D1 (fourth host exception), INV-D9, INV-S15, INV-B6
