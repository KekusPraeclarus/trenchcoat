---
description: ADR — Channel watch prose uses host-derived watchWindow; audit horizonHours stays settlement math only.
scope: project
status: accepted
last_verified: 2026-07-30
---

# ADR 013 — Watch window decoupled from audit horizon

## Context

Channel distillers (Telegram overview, Discord bottom-line) kept echoing mechanical
hour horizons (`72h`, `in 72 hr`) because `auditClaim.horizonHours` was framed into
the prompt and outbound copy tried to regex-rewrite every variant into one fixed
phrase (`the next few days`). That was both rigid and over-engineered: audit
settlement is intentionally locked to +24h / +72h / +7d, while trader-facing prose
needs day / conditional / month language (`the next few days`, `if it holds`,
`this month`, `through next month`) that is not the same object as the settlement
clock. Weekly timeframes were later banned from watch copy entirely (see below).

## Decision

- Keep `AuditClaim.horizonHours` (1–168) and audit pricing horizons unchanged —
  settlement math only. No agent-authored watch field on outbox proposals.
- Host derives a closed allowlist `watchWindow` at distill time from claim type +
  `horizonHours` (`src/lib/watch-window.ts` / `deriveWatchWindow`). Narrative and
  rotation claims may sit one communicative bucket longer than raw hours; token /
  sentiment claims stay closer to the hour bucket.
- Inject `watchWindow=…` into distill claim lines (omit prose-facing
  `horizonHours=N`). Prompts require that scale or a synonym; never paste `Nh`.
- Weekly timeframes never reach watch copy: week-scale buckets derive the
  conditional `if it holds` (prompts turn it into e.g. "worth watching if volume
  holds"), and the outbound scrub rewrites weekly phrases (`this week`, `over the
  coming weeks`, `next week`) to the same conditional. Day and month windows are
  unchanged.
- Outbound / post-check scrub is thin: replace leaked `24h|72h|168h` (and common
  wrappers) plus the weekly-timeframe rewrite; leave other natural phrases alone.
- Separately (same session, delivery path): router Telegram fanout uses the same
  markdown→HTML + `parse_mode: HTML` path as operator DMs (`telegramSendFormattedChunks`),
  and deslugs kebab narrative labels for display (`rh-chain-meme-rotation` →
  `RH Chain Meme Rotation`).

## Consequences

- Channel copy can say month-scale watch windows without expanding claim horizons
  or lying about settlement maturity.
- Agents must not invent `watchWindow`; host policy is the single source.
- Thin scrub cannot infer claim type from a bare hour leak — week-scale `168h`
  leaks default to `this month`; good prose must come from distill following
  `watchWindow`.
- Future sessions should not reintroduce a heavy phrase rewriter or paste
  `horizonHours` into copy-facing distill framing.

## Alternatives considered

- **Prose-only synonyms within 24/72/168** — rejected; cannot honestly surface
  “this month” for sticky narrative heat.
- **Expand `horizonHours` beyond 168** — rejected; couples settlement schema to
  communication needs and risks audit confusion.
- **Agent-authored `watchWindow` on proposals** — rejected; untrusted prose field
  with no host policy, easy to game or drift.

## Follow-ups

- None required for acceptance. Optional later: expose `watchWindow` on channel-render
  receipts for operator debugging.
