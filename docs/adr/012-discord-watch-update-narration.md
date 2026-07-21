---
description: ADR — Discord watch updates use host-side glossed LLM narration with soft prose fallback, not scripted metric bullets.
scope: project
status: accepted
last_verified: 2026-07-21
---

# ADR 012 — Discord watch update narration

## Context

ADR 010 added six-hour material watch updates on the isolated Discord research
bot. The monitor already called a host-side `composer-2.5` writer
(`WATCH_UPDATE_PROMPT`), but production often shipped the **facts-only fallback**:
`Scan: <timestamp>` headers and inventory lines like
`Security flags: unverified-source → none` and `X engagement: 990 → 299`.

That read as scripted telemetry, not a message a trader typed. Common causes:
LLM session failure, validation rejection (em-dashes alone forced fallback), and
raw scanner flag codes in the model input that encouraged copy-paste output.
Initial research replies already sounded conversational via the agent
`chat-summary.md` path; watch updates did not.

## Decision

- **Primary path:** keep host-side `runWatchUpdateWriter` (`composer-2.5`,
  ask-mode, `PERSONA_VOICE`) — do **not** route watch updates through the
  deep-research agent or `chat.discord.model` fast path.
- **Glossed inputs:** `formatMaterialChangeGloss` in `src/discord/materiality.ts`
  translates material diffs into trader English before the model sees them; drop
  `scanAt` from the user message. Security status/flag churn is not material for
  watch updates (research/subscribe gates still use security).
- **Prompt contract:** `WATCH_UPDATE_PROMPT` requires takeaway-first prose,
  1–2 beats of context per shift, and forbids `Scan:` timestamps and
  `label: prior → current` inventory lines.
- **Validation:** normalize em-dashes to `-` before output checks instead of
  rejecting and falling back.
- **Retry:** one retry on session error or validation failure.
- **Fallback:** `renderWatchUpdateFactsOnly` emits short prose sentences (no
  `Scan:`, no raw flag codes) — never the old bullet changelog. Monitor logs
  `discord watch update fallback for <tokenKey>: <reason>` when fallback ships.

## Consequences

- Watch updates can match the voice of other Discord flows when the LLM path
  succeeds; users no longer see scan receipts or opaque scanner codes by default.
- Best-quality copy still depends on Cursor CLI availability under
  `~/.trenchcoat/discord/agent/`; persistent fallback warnings in monitor logs
  are the ops signal.
- Materiality thresholds stay host-deterministic; only narration is LLM-assisted.
- Initial research and watch updates remain **two models / two paths** — docs
  and debugging must not conflate them.

## Alternatives considered

- **Skip Discord send when LLM fails** — rejected; material tape/social moves
  must still reach subscribers (security flag churn is not a watch trigger).
- **Soft prose only (no LLM)** — rejected; no flexibility for engagement context
  or thesis anchoring from `researchBrief`.
- **Reuse deep-research agent for updates** — rejected; too heavy for a short
  delta note on a six-hour cadence; violates the lightweight host writer ADR 010
  implied.
- **Keep bullet fallback minus `Scan:`** — rejected; still reads as scripted.

## Follow-ups

- Watch fallback rate in monitor logs; if `session-error` dominates, treat as
  CLI/workspace ops (same class as main harness).
- Extend gloss map when new `SecurityFlag` values are added in
  `src/collectors/market/security.ts`.

## References

- [architecture/discord-research.md](../architecture/discord-research.md)
- [knowledge/discord.md](../knowledge/discord.md)
- ADR 010 in [010-discord-research-isolation.md](010-discord-research-isolation.md)
- `src/discord/watch-update-session.ts`, `src/discord/materiality.ts`,
  `src/prompts/host.ts`
