---
description: ADR — Discord NL idea-tracking under isolated Discord state; mention/reply intake; durable match batches; INV-D3–D8.
scope: project
status: accepted
last_verified: 2026-07-21
---

# ADR 018 — Discord idea tracking

## Context

Guild members wanted to ask the Discord research bot to watch for *ideas* (e.g.
“privacy/mixer on RH with decent backing”) and get pinged when matching talk
appears in scans or research — without a confirmation UX, and without running
`composer-2.5` on every channel message.

Existing Discord surfaces already covered:
- Router webhook broadcasts (budgeted)
- Gateway research + token watchlist (ADR 010 / 012)
- Host chain-integration lane (ADR 016)

Idea-tracking is a third interactive product on the same Gateway bot, but it is
not token-watch and must not let model output choose guild/channel/user, mentions,
or quotas. Matching must not fail or roll back parent `list-scan` /
`farcaster-scan` / `research` runs.

## Decision

- Store host-owned requests under `~/.trenchcoat/discord/tracking.json`
  (schema-validated transitions in `tracking-state.ts`, lock via Discord
  `layout.lock`). Config: `chat.discord.tracking` (default `enabled: false`).
- **Intake gate:** after renew / deterministic research / chain-integration fall
  through, only @mention or reply-to-bot messages hit the intent classifier.
  Research intents keep priority even when the bot is mentioned.
- **Models:** `intent_model` and `match_model` default to `composer-2.5` (not
  fast). Sessions are sandboxed, fixed-prompt, path-only over SnapshotWriter
  envelopes (`trust: untrusted-external`). Fail closed on malformed output.
- **No confirmation prompts.** Low-confidence track → silent `tentative`; a
  second qualifying message within 24h may confirm. High confidence activates
  immediately. Success ack is 🫡 after commit (track/drop/extend/decline).
- **Cap:** 10 active per `(guildId, userId)`, 30-day TTL. Over-cap →
  `pending-capacity` + list/drop dialogue; drop activates newest pending.
- **Matching:** orchestrator and Discord research enqueue durable `matchBatches`
  after sealed artifacts; a Discord tracking worker claims oldest-first.
  Parent runs never fail because of matching. Hits produce host-rendered pings
  with `allowed_mentions.users = [owner]` only; research-origin reuses summaries;
  X/FC hits may enqueue `origin: "tracking"` research (bypasses per-user caps,
  still counts server daily).
- **Expiry:** monitor sweep bundles elapsed + next `<48h` (exact 48h excluded);
  one notice per cycle; NL extend/decline via the same classifier.
- Invariants **INV-D3–D8** (D5/D7/D8 remain PARTIAL where live model quality or
  Discord API ambiguity cannot be closed offline). INV-D1 gains a third bounded
  host exception for tracking notifications / tracking-origin research.

## Consequences

- Idea-tracking is cheaper than “classify every message” but members must
  @mention or reply to the bot — docs must not say “no mention required” without
  the research-vs-tracking distinction.
- Matching latency/cost scales with active request count × scan volume; early-out
  when zero active requests keeps scan latency unchanged.
- Enabling in production requires a live composer-2.5 eval archive in
  `docs/architecture/discord-tracking.md` (INV-D8); keep `enabled: false` until then.
- Ambiguous Discord sends after `sending` are marked terminal without blind
  resend (INV-D7 PARTIAL) — prefer miss over duplicate ping.
- SnapshotWriter callers under `src/discord/tracking-*.ts` are allowlisted for
  INV-I4 static ownership (isolated Discord agent workspace only).

## Alternatives considered

- Classify every non-research channel message → rejected (cost/latency).
- `composer-2.5-fast` for match batches → rejected in favour of match quality
  (operator choice for this feature).
- Agent-written tracking state → rejected (INV-D3 host-only).
- Fail parent scan/research on matcher errors → rejected (INV-D6).

## Follow-ups

- Run opt-in `tests/e2e/discord-tracking-model-live.test.ts` and archive metrics
  before flipping `chat.discord.tracking.enabled`.
- Optional Discord message nonce reconciliation if the API surface becomes
  reliable enough to tighten INV-D7.

## References

- [architecture/discord-tracking.md](../architecture/discord-tracking.md)
- [architecture/discord-research.md](../architecture/discord-research.md)
- ADR 010 (Discord research isolation), ADR 012 (watch update narration),
  ADR 016 (chain integration)
- INV-D1, INV-D3–D8 in [INVARIANTS.md](../INVARIANTS.md)
