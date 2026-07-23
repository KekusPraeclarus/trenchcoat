---
title: "033 — Hot-day broadcast lane budgets (Discord 100 / Telegram overview 50)"
status: accepted
date: 2026-07-23
last_verified: 2026-07-23
---

# ADR 033: Hot-day broadcast lane budgets

## Context

On a busy tape day (2026-07-23), Telegram kept receiving host-approved market
broadcasts while Discord went quiet after early afternoon. Channel-render
receipts showed `discord: budget-skipped` / `budget:daily-budget` once the
Discord lane hit `broadcast.daily_budget` (then 5). Telegram remains uncapped
by message count after worthiness (INV-B2 / ADR 014); Discord does not.

Operators want hot days to fan out to Discord without early exhaustion, while
Telegram topic distill stays bounded by its own LLM session cap (not a message
count ledger). Schema previously maxed `daily_budget` at 50, blocking a live
setting of 100.

## Decision

1. **Discord message lane (ops target):** `broadcast.daily_budget = 100` and
   `broadcast.urgent_ceiling = 100` on live config. Schema defaults stay
   conservative (5 / 10); schema **max** raised to **200** so ops can set 100
   without a further code change for modest headroom.
2. **Discord distill LLM cap:** `broadcast.discord_distiller.daily_cap = 100`
   (fallback to `event.text` when exhausted — does not omit Discord).
3. **Telegram topic distill LLM cap:** `broadcast.telegram_overview.daily_cap = 50`.
   This is **not** a Telegram message-count budget; messages still fan out
   uncapped after worthiness, with packet/fallback text when the LLM cap trips.
4. **Unchanged Discord run rule:** at most one Discord payload per run
   (`run-deduped`); later same-run claims stay Telegram-only.
5. **Diagnosis:** when Telegram fires and Discord does not, check
   `archive/runs/<run-id>/channel-render-receipts.json` for `budget-skipped` /
   `run-deduped` before assuming worthiness or ingestion failure.

## Consequences

- Hot-day Discord parity with Telegram improves until ~100 non-urgent (or
  urgent-ceiling) Discord attaches; worthiness and narrative dedupe still gate
  both destinations upstream.
- Distill LLM session caps remain separate from Discord message budget; shared
  `usedToday` counter in `renderChannelPayloads` still couples session burn
  across the two distillers in one run.
- Raising Discord budget does not remove `run-deduped`; multi-claim runs still
  under-deliver to Discord relative to Telegram topic leaders.
- No Telegram daily **message** ledger (still deferred per ADR 014 follow-ups).

## Alternatives considered

- **Raise Discord budget only to schema max 50** — rejected; operator asked for
  100 and mid-day volume already exceeded 5 early.
- **Add a Telegram message daily_budget mirroring Discord** — rejected; would
  invert INV-B2 / ADR 014 “Telegram uncapped after validation” and duplicate
  worthiness as a volume brake.
- **Remove Discord run-dedupe** — deferred; separate product choice from budget
  exhaustion; not required to fix the observed TG≠Discord gap.

## Follow-ups

- Optional: revisit `run-deduped` if operators want per-subject Discord parity
  with Telegram topic leaders inside one run.
- Optional: Telegram hourly/daily message ledger only if worthiness under-filters
  (ADR 014).

## Related

- [ADR 014](014-broadcast-worthiness.md) — semantic gate; Telegram uncapped by count
- [ADR 001](001-router-delivery-guarantee.md) — Discord budget at channel-render
- [ADR 026](026-telegram-digest-and-topic-fanout.md) — Telegram topic + digest modes
