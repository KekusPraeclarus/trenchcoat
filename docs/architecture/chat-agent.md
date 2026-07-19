---
description: Chat agent module - Telegram bridge to a minimal orchestrator session that proposes confirmation-gated research, keeping the conversational context window small.
scope: module
status: active
last_verified: 2026-07-19
read_when:
  - Editing src/chat/ or the agent's chat / deep-research skills.
  - Changing how conversations trigger research or how replies leave the machine.
---

# Chat agent

## Purpose

The operator's conversational window into everything the bot knows: discuss
findings, probe research that never met the broadcast bar, and ask for an opinion
on any token — answered by combining stored knowledge with fresh on-demand
research. Distinct from broadcasts (outbound, via the in-repo router); this is
inbound, interactive, operator-only. Host chat-recall markdown under
`reports/chat/` is a status dump for DM recall — market Telegram fanout uses the
overview distiller, not that file as-is (see knowledge/telegram.md).

## Minimal-orchestrator pattern

The conversational session must survive long chats without bloating, so it does as
little as possible itself:

- **Chat session** (`skills/chat/`) — resumable Cursor CLI chat (`agent create-chat`
  + `--resume`) within a conversation, run in `--mode ask` (read-only). Holds
  only: the conversation, `state/INDEX.md`, and any chat reports already on disk.
  It answers directly when the index and existing context suffice. Host prompt
  and chat skill both say "read INDEX first" — if
  `~/.trenchcoat/agent/state/INDEX.md` is missing, the session has no rollup
  (scaffold / agent-workspace.md).
- **Research proposal (host)** — fail-closed host extractor
  (`src/chat/research-intent.ts`, shared CA helpers in
  `src/chat/research-intent-core.ts`) detects research-shaped operator text and asks
  for an explicit `confirm` / `cancel`. Pending proposals live in
  `~/.trenchcoat/pending-research.json` (mode 600), bound to
  `TELEGRAM_OPERATOR_ID`, with TTL from `config.chat.research_confirm_ttl_minutes`.
  Chain may be constrained with `on base` / `on solana` / etc. (or `chain:address`).
  Bare Solana base58 mints (32–44 chars) and EVM `0x…` CAs are extracted as
  `tokenHint` so natural-language filler (`perform deep research on …`) cannot
  pollute the DexScreener search query. Without a chain hint the host ranks
  DexScreener hits across supported chains by liquidity+volume credibility
  (token-resolution.md) — ethereum is not a default.
  When several CAs remain credible, the host DMs a numbered shortlist that always
  includes the chain (`1. base:0x…`) and waits for a pick (`1`–`5` or
  `chain:address`) before continuing.
- **Research sub-agent** (`skills/deep-research/`) — after confirm, the listener
  asynchronously calls `processNextConfirmedResearch` →
  `runOperatorResearchNow` (workspace writer lock held). Collectors + optional
  Tavily Search + bounded X token search run on the host only; the agent stays
  network-denied. Reports include a Sentiment & popularity section from
  `twitter-*` inbox snapshots when present. Malformed
  `decision-proposals.json` is dropped (no watchlist mutation) so the research
  report still completes — same fail-closed pattern as chat-summary / outbox.
  Report lands at `reports/chat/<run-id>.md`; the chat session may then
  summarize it.
- **Run recall** — `list-scan`, `narrative-scan`, `farcaster-scan`, `review`, and
  `research` always get a host-rendered `reports/chat/<run-id>.md` after terminal
  success/degradation (even with zero staged broadcasts). Trusted host facts come
  first (job/status, collection, freshness/platform coverage, queue/watchlist
  mutations, engagement, staged broadcasts, receipt paths). Optional agent
  `chat-summary.json` / research `chat-summary.md` context is appended only when
  validated (`chat-report.ts`). Missing or malformed proposals never suppress the
  host summary. Agents never write `reports/chat/` directly; bypass files are
  removed. Summaries remain untrusted evidence.
- Ordinary recall questions never take the writer lock.

## Design

- `tc listen telegram` long-polls Bot API (no inbound port) and bridges private
  DMs to the chat session (`cwd` = `~/.trenchcoat/agent`, sandboxed)
- **Operator-only**: messages accepted only from `TELEGRAM_OPERATOR_ID`; group
  chats are dropped; replies always target that operator id, never the inbound
  `chat.id` if it differs (INV-B3)
- Host commands: `/start`, `/status`, confirm/cancel, and research proposals
  reply without an ask-mode agent turn
- **Session policy**: Cursor chat id persisted in `~/.trenchcoat/chat-session.json`;
  rotated after `config.chat.idle_timeout_minutes` (default 30). Knowledge store
  is long-term memory; sessions stay disposable
- **Streaming**: chat turns use Cursor `--output-format stream-json
  --stream-partial-output`. Partials go to Telegram `sendMessageDraft` (Bot API
  9.5+; same `draft_id` animates updates). Drafts are ephemeral — the host then
  `sendMessage`s the final text so it persists. Bot API calls live in
  `src/lib/telegram-bot.ts` / `src/cli.ts`, not under `src/chat/` (INV-R4)
- Operator DMs use `telegramSendOperatorMessageChunks`: host strips workspace
  paths / artifact filenames (`reports/…`, `decision-proposals.json`, …), maps a
  safe markdown subset (`**bold**`, `#` headers, `` `code` ``) to Telegram HTML
  (`parse_mode=HTML`), and falls back to plain stripped text on Bot API reject.
  Router/broadcast delivery stays plain. Final `sendMessage` never truncates:
  `splitTelegramText` chunks at ~3800 chars (`1/n` …). Overlong replies also land
  under `reports/chat/` with a summary that does **not** cite the path in chat.
  Draft previews stay plain (no parse_mode). Voice from `skills/chat/SKILL.md`
- **Outbound operator DMs** (alerts, research progress/completion) remain
  host-authored templates on the same bot — never agent free-text outside the
  chat turn path

## Token-burn notes

- Chat turns use ask mode so they do not take the workspace writer lock (INV-S15)
- Recall questions are answered from the store without collectors
- Confirmed research acquires the writer lock in `runOperatorResearchNow`; if the
  lock is held, the durable confirmed request stays `queued` and the pump retries

## Source files

- `src/cli.ts` (`listen telegram`) — Bot API long-poll, draft stream, research pump
- `src/lib/telegram-bot.ts` — `sendMessage` / operator HTML send / chunked send / `sendMessageDraft` / `sendChatAction`
- `src/lib/telegram-format.ts` — strip local refs + markdown → Telegram HTML
- `src/chat/telegram-reply.ts` — prepare final reply (chunk + optional chat report)
- `src/chat/handler.ts` — allowlist, host commands, research confirm gate
- `src/chat/research-intent.ts` — fail-closed research intent extraction
- `src/chat/pending-research.ts` — durable pending/confirmed request store
- `src/chat/session.ts` — Cursor chat lifecycle + streaming turn runner
- `src/chat/draft.ts` — throttled draft updates
- `src/lib/cursor-stream.ts` — stream-json assistant delta merge
- `src/chat/prompt.ts` — operator-text scrub / chat prompt / Telegram truncate
- `src/chat/telegram.ts` — reusable poll helper (idle-bounded)
- `src/orchestrator/research.ts` — operator enqueue + locked research run
- `src/orchestrator/chat-report.ts` — host facts + optional proposal validation/render for list/narrative/farcaster/review/research chat recall
- `agent/skills/chat/SKILL.md` — conversational contract + voice
- `agent/skills/deep-research/SKILL.md` — sub-agent contract

## Discord research (separate bridge)

Telegram chat above is **operator-only with confirm/cancel**. Discord research is a
different product surface (ADR 010):

- Gateway listener (`tc listen discord`), not the router webhook
- Any guild member in configured channels; no `TELEGRAM_OPERATOR_ID` allowlist
- ✅ reaction when research starts; final-only text replies (no confirm /
  progress messages)
- State under `~/.trenchcoat/discord/` with its own lock; main
  `pending-research.json` / research queue are not used
- Intent: `src/discord/intent.ts` (stricter CA-required policy)

Full contract: [discord-research.md](discord-research.md).

## Gotchas and security-sensitive boundaries

- The Telegram bot token lives in the chat service env, never under `agent/`
  (INV-I3). `TAVILY_API_KEY` is host-only and scrubbed from Cursor child env
- Inbound chat text is operator-authored but still crosses into the sandbox —
  deliver it as the session prompt, never write it into the knowledge store
  verbatim without attribution
- `src/chat/` must not call upstream market APIs (INV-R4); Bot API traffic stays
  in `src/cli.ts`. Research collectors live under `src/orchestrator/` /
  `src/collectors/`
- A model can propose research subjects or web-search *queries*; only an
  allowlisted operator `confirm` authorizes execution, and the host never fetches
  model-selected URLs
- Replies must never go to a chat id outside the allowlisted operator (INV-B3)
- Idle expiry must use the injected turn clock (`Date.parse(nowIso())`), not
  wall-clock `Date.now()`. Fixture-date or clock-injected tests otherwise look
  “expired” and silently rotate the Cursor chat id
- Launchd runs `~/.trenchcoat/bin/trenchcoat` against a **deployed**
  `~/.trenchcoat/runtime`, not the repo `dist/`. After host-gate changes
  (`research-intent`, `handler`, listener), redeploy via `ops/install-launchd.sh`
  (it wipes `dist/` before `tsc` so deleted modules do not linger) or Telegram
  will still hit the old binary. Skills and `AGENTS.md` under
  `~/.trenchcoat/agent/` are a **separate copy** from the repo `agent/` tree —
  after editing any skill (`list-scan`, `narrative-scan`, `review`, `chat`,
  `deep-research`, `farcaster-scan`, …) or runtime `AGENTS.md`, sync those
  artifacts into `~/.trenchcoat/agent/` before expecting live jobs to see them
  (`tc init` only copies on first create; later repo edits do not auto-propagate)
- Confirm/cancel with no pending proposal must not write an unbound
  `pending-research.json` (empty `telegramUserId` failed Zod and crash-looped
  launchd when offset could not advance). Listener wraps each update in
  try/catch so one bad message cannot wedge the poll loop
