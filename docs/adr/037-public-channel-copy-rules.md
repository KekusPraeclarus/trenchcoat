---
description: ADR — Public Discord/Telegram copy bans internal jargon and crutch time framing; host prompts + mechanical distill reject.
scope: project
status: accepted
date: 2026-07-24
last_verified: 2026-07-30
related: [013, 012, 026, 036]
---

# ADR 037 — Public channel copy rules

## Context

Production Discord and Telegram posts were leaking trenchcoat internals and
sounding like operator checklists:

- Internal pipeline vocabulary: "operator tape", "operator-list", "lane noise",
  "call rail", "owns operator tape", "ignore thin operator-list noise"
- Stock-trader metaphor: "tape" used as a stand-in for market activity
- Crutch time framing: nearly every message ended with "this week" because
  distill prompts echoed the host-derived `watchWindow` (often `this week` for
  narrative claims — ADR 013) as headline framing instead of optional
  forward-looking watch language

Channel readers are public traders with zero knowledge of host distillers,
worthiness gates, or narrative slugs. The Discord bottom-line prompt even
instructed "Tape ownership + what to watch + what to ignore", which directly
caused the bad output.

## Decision

1. **Shared prompt contract (`PUBLIC_COPY_RULES` in `src/prompts/host.ts`).**
   Inject into every public-facing host prompt: Discord bottom-line, Telegram
   topic, daily digest bodies, watch updates, and correction copy. Rules:
   - No internal jargon (`tape`, `operator`, `operator-list`, `lane noise`,
     `call rail`, watch/ignore checklist framing)
   - Never tell readers what to "ignore" — omit noise instead
   - Time phrasing is forward-looking only and appears at most once; never frame
     the update as "this week's news". Weekly timeframes are banned entirely —
     week-scale watch language uses a condition instead ("worth watching if
     volume holds"); daily/monthly phrasing stays allowed.
   - Describe market/price/volume/attention in plain trader language

2. **Mechanical post-check (`INTERNAL_JARGON` in `src/orchestrator/distill-session.ts`).**
   Fail-closed distill validation rejects Discord bottom-lines, Telegram topic
   paragraphs, and daily digest section bodies that match `\btape\b`,
   `\boperator…\b`, or `\blane noise\b`. Reason: `internal-jargon`. Prompt-only
   fixes are insufficient when models drift.

3. **Agent voice mirror (`agent/AGENTS.md`).** Outbox `text` is source material
   for distillers; the runtime agent gets the same audience rules so drafts do
   not seed internal vocabulary. Worthiness and other JSON-only host prompts are
   unchanged — they never reach public channels.

4. **`watchWindow` relationship (ADR 013).** Host still derives `watchWindow`
   from claim type + `horizonHours` for settlement-scale guidance. Prompts
   require forward-looking phrasing at that scale when time is mentioned at
   all, not headline repetition. Week-scale buckets now derive the conditional
   `if it holds`, and the egress scrub (`scrubWatchProse`) rewrites any weekly
   timeframe phrase that still slips through to the same conditional.

## Consequences

- Public posts read like a trader wrote them, not like pipeline telemetry.
- Distill retries may increase briefly when models emit banned jargon; fallback
  paths still apply after retry exhaustion.
- The mechanical regex is intentionally narrow (tape/operator/lane noise) — new
  leak patterns need prompt updates and possibly regex extension.
- Operator-facing docs and worthiness JSON may still use "tape" / "operator" /
  "lane" internally; only channel egress is restricted.
- `this week` is no longer a host `watchWindow` value (superseded 2026-07-30):
  week-scale claims derive `if it holds` and weekly phrases are scrubbed on
  egress.

## Alternatives considered

- **Prompt-only fix** — rejected; production already had bad instructions
  ("Tape ownership + what to watch + what to ignore") and models still drifted.
- **Heavy phrase rewriter on outbound text** — rejected; same failure mode as
  ADR 013's abandoned hour-horizon rewriter — hides bad distill instead of
  rejecting and retrying.
- **Ban `this week` entirely in scrub** — rejected at the time; forward-looking
  week-scale watch language was considered fine. Superseded 2026-07-30: weekly
  timeframes are now banned in watch copy and rewritten to the conditional
  `if it holds` on egress.

## Follow-ups

- Optional: extend `INTERNAL_JARGON` if new leak patterns appear in production
  (e.g. "spam stack", "call rail") after prompt soak time.
- Optional: add the same check to watch-update validation if Discord research
  updates show the same drift.
