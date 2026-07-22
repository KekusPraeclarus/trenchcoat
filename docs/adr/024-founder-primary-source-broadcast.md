---
description: ADR — Founder/protocol primary-source catalysts must produce a market broadcast proposal without CT-cluster or stage-shift prerequisites.
scope: project
status: accepted
last_verified: 2026-07-22
---

# ADR 024 — Founder primary-source catalyst broadcasts

## Context

Live audit of a missed Telegram / TON-ecosystem narrative (native Gram wallet
announcement attributed to Pavel Durov, Jul 2026) showed the collectors and
archive were fine: sealed list-scan inboxes held both an early CT relay and the
full primary-source FYP post, and narrative-scan market attention named
`Gram (prev. Toncoin)`. The agent still wrote no outbox and no narrative slug —
it treated the signal as "incremental sentiment" / "no heat/stage delta" and
optimised FYP-only runs for engagement likes on incumbent narratives (e.g. RH
rotation).

Host gates from [ADR 023](023-narrative-development-and-research-broadcast.md)
never ran because nothing was proposed. Operator intent: a founder or protocol
official announcing a material product, wallet, protocol, ecosystem, or
distribution catalyst must notify channels even without prior narrative stage
or multi-author CT cluster.

## Decision

- **Agent skills** (`list-scan`, `narrative-scan`, `farcaster-scan`, root
  `agent/AGENTS.md`): when sealed inbox evidence includes a post from a clearly
  identifiable founder, CEO, protocol official account, or official project
  channel announcing such a catalyst, the run **must** write one
  `outbox/<run-id>.json` item. Empty outbox remains allowed only for ordinary
  feed noise.
- Open a new `narrative-emergence` slug when none matches (honour prior tickers /
  rebrands in evidence). Use `narrative-development` when a matching slug
  exists. Severity at least `watch`; prefer `notable` for blue-chip founders or
  billion-user scale claims. Cite the primary-source inbox path in `refs`.
- **Worthiness** ([ADR 014](014-broadcast-worthiness.md)): approve first-time
  founder primary-source catalysts; never reject as "incremental sentiment" or
  "no stage delta" when absent from accepted-broadcast-history.
- Codified in INV-B2. Still **skill-enforced** (agent-authored text, INV-B2): the
  host does not invent outbox items when the agent omits them. Failed agent
  sessions / `--skip-agent` still cannot broadcast.

## Consequences

- Primary-source catalysts no longer depend on CT pile-on or an existing
  narrative stage transition before operators hear about them.
- FYP-only list-scans must treat founder posts as broadcast candidates, not
  engagement-only feed colour.
- Mis-skips remain possible if the model ignores skills; diagnosis is sealed
  inbox evidence present + empty outbox (see orchestrator broadcast audit).
- Does not backfill historical misses.

## Alternatives considered

- **Host invents broadcast text from sealed founder posts** — rejected; INV-B2
  authorship.
- **Host hard-fail research-style lint when founder keywords appear without
  outbox** — deferred; fragile on name recognition and false positives; skills
  + worthiness first.
- **Require operator-list coverage of founder accounts** — insufficient alone;
  the miss already had FYP primary source.

## Related

- [ADR 014](014-broadcast-worthiness.md), [ADR 023](023-narrative-development-and-research-broadcast.md)
- INV-B2, `agent/skills/list-scan`, `narrative-scan`, `farcaster-scan`
