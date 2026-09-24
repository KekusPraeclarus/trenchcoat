---
title: "054 — Drop planned trading pipeline"
status: accepted
date: 2026-09-22
last_verified: 2026-09-22
---

# ADR 054: Drop planned trading pipeline

## Context

`docs/trading/` held a design for a paper-to-live trading pipeline.
No code was built.
Trading now lives in separate systems.
Those systems consume this repo's narrative output through the desk pull-queue
(`trench.intake.v1`).

## Decision

Remove `docs/trading/`.
trenchcoat stays advisory-only under INV-A1.
This repo does not add trading jobs, trading state, or execution code.

## Consequences

`docs/README.md` and `README.md` lose the trading rows.
Probe P75 in `ops/context-probes.md` changes its expected answer.
Any future trading proposal needs a new ADR that revisits INV-A1.

## Alternatives considered

- Keep `docs/trading/` as historical design. Rejected. It implied a future
  in-repo pipeline and conflicted with INV-A1 and external trading systems.

## Related

- Advisory boundary: [INVARIANTS.md](../INVARIANTS.md) INV-A1
- Desk intake: [adr/051-desk-ready-pull-queue.md](051-desk-ready-pull-queue.md)
- Doc probes: [../../ops/context-probes.md](../../ops/context-probes.md)
