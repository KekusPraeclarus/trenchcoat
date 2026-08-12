---
description: ADR — Public Discord/Telegram copy bans internal jargon, CG category list chatter, and crutch time framing; host prompts + mechanical distill reject.
scope: project
status: accepted
date: 2026-07-24
last_verified: 2026-08-12
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
- CoinGecko trending-category list churn: sprays of "X cat #N on CG" /
  "off CG cats" messages, with `cat`/`cats` as category shorthand that reads
  as cat memecoins

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
   - Never abbreviate CoinGecko categories as `cat`/`cats`; no CG list-position
     chatter (`on CG` / `off CG` / `cat #N`)
   - Never tell readers what to "ignore" — omit noise instead
   - Time phrasing is forward-looking only and appears at most once; never frame
     the update as "this week's news". Weekly timeframes are banned entirely —
     week-scale watch language uses a condition instead ("watch if volume
     holds"); daily/monthly phrasing stays allowed. The stock closer
     "worth watching" is banned — vary watch language or omit time phrasing
     when the takeaway already stands.
   - Describe market/price/volume/attention in plain trader language

2. **Mechanical post-check (`INTERNAL_JARGON` / `STOCK_WATCH_PHRASE` in
   `src/orchestrator/distill-session.ts`).**
   Fail-closed distill validation rejects Telegram topic paragraphs and daily
   digest section bodies that match `\btape\b`, `\boperator…\b`,
   `\blane noise\b`, CG category list-position / `cat` shorthand patterns
   (reason: `internal-jargon`), or `\bworth watching\b` (reason:
   `stock-watch-phrase`). Prompt-only fixes are insufficient when models drift.

3. **Outbox mechanical gate (`cg-category-list-churn`).**
   `evaluateMechanicalBroadcastGate` rejects proposal `text` that is CoinGecko
   category enter/leave/rank chatter (including founder-urgent pass-through).
   Category ranks stay inbox confirmation context for capital-flow rotation;
   they are not channel fuel. Agent skills (`narrative-scan`, broadcast
   checklist) mirror the same bar.

4. **Agent voice mirror (`agent/AGENTS.md`).** Outbox `text` is source material
   for distillers; the runtime agent gets the same audience rules so drafts do
   not seed internal vocabulary. Worthiness and other JSON-only host prompts are
   unchanged — they never reach public channels.

5. **`watchWindow` relationship (ADR 013).** Host still derives `watchWindow`
   from claim type + `horizonHours` for settlement-scale guidance. Prompts
   require forward-looking phrasing at that scale when time is mentioned at
   all, not headline repetition. Week-scale buckets now derive the conditional
   `if it holds`, and the egress scrub (`scrubWatchProse`) rewrites any weekly
   timeframe phrase that still slips through to the same conditional.

## Consequences

- Public posts read like a trader wrote them, not like pipeline telemetry.
- Distill retries may increase briefly when models emit banned jargon; fallback
  paths still apply after retry exhaustion.
- The mechanical regex stays narrow — new leak patterns need prompt updates and
  possibly regex extension (CG category list patterns added 2026-08-04).
- Operator-facing docs and worthiness JSON may still use "tape" / "operator" /
  "lane" / "category" internally; only channel egress is restricted.
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
- **Worthiness-only CG filter** — rejected; worthiness never sees proposal
  wording (claim+refs only), so list-churn must be a mechanical text gate.

## Follow-ups

- Optional: extend `INTERNAL_JARGON` if new leak patterns appear in production
  (e.g. "spam stack", "call rail") after prompt soak time.
- Optional: add the same checks to watch-update validation if Discord research
  updates show the same drift.
