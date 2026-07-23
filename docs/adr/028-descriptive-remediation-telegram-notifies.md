---
title: "028 — Descriptive remediation Telegram operator notifies"
status: accepted
date: 2026-07-23
---

# ADR 028: Descriptive remediation Telegram operator notifies

## Context

After Discord suggestion intake (ADR 025) went live, operator Telegram alerts
were opaque one-liners: outcome tokens only
(`forming, queued-waiting, queued`) and bare stage errors
(`propose:session failed`). Operators could not tell what idea was queued,
what capacity wait meant, or whether a failure was a product rejection vs a
Cursor session glitch.

## Decision

1. Host-compose suggestion digests and remediation failure alerts from
   sanitized ledger/incident fields (outcome labels, category, summary or
   forming note, incident id, stage explanation).
2. Optionally polish that host draft with `composer-2.5` (ask mode, sandbox);
   fail closed to the host text if the session fails, invents ids, or returns
   empty/short output.
3. Never put raw Discord message bodies into Telegram — only host-validated
   summaries already scrubbed for secrets.

## Consequences

- Operator chat becomes actionable without SSH into the ledger.
- Slight extra latency/cost on digest/failure days when polish succeeds.
- INV-S27 trust boundary unchanged (path/summary only).

## Alternatives considered

- Host-only templates with no LLM — sufficient, but user requested optional
  `composer-2.5` clarity for operator-facing prose.
- Raw classifier dumps — rejected (opaque, can leak untrusted phrasing).

## Follow-ups

- Redeploy, then `tc remediations retry` / `scan` / `run` to drain the
  post-lock-starvation backlog (see ADR 027).
