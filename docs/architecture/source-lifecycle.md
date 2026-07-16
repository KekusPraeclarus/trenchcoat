---
description: Host-owned FYP source candidacy, lagged promote/demote gates, and managed private X list synchronization.
scope: module
status: active
last_verified: 2026-07-16
read_when:
  - Editing src/sources/, src/collectors/twitter/managed-list.ts, or source-list orchestration.
  - Changing promotion/demotion thresholds or X list membership behaviour.
---

# Source-list lifecycle

## Purpose

Discover promising X accounts from the FYP, score them from settled call
outcomes, and keep one managed list in sync — without ever letting a
model choose members or mutate X.

Binding decision: [ADR 004](../adr/004-dynamic-x-list-lifecycle.md).

**Current limit:** the review engine is wired, but production
`source-list-review` still defaults to an empty outcome set
(`src/orchestrator/source-list.ts`). Do not run live promote/demote until sealed
audit outcomes feed `aggregateSourcePerformance`. Prefer
`tc source-list review --dry-run`.

## State

| File | Owner | Role |
|---|---|---|
| `agent/state/sources.json` | host | Per-source quality scores (audit / dock) |
| `agent/state/source-lifecycle.json` | host | FYP candidates, immutable transitions, pending sync ids, managed list id |

Integrity snapshots include `source-lifecycle.json` (INV-S7 family). The agent
must not write either file.

## Collection targets

`list-scan` scrapes four targets when configured:

1. Home / FYP (`scrape_home`) — also the only feed eligible for like/follow proposals
2. Operator list 1 (immutable discovery)
3. Operator list 2 (immutable discovery)
4. Managed private list (if `managed_list.list_id` set)

Posts are deduped by post id across targets; first-seen provenance wins.
Authors from FYP **or either operator list** enter shill probation. Operator
lists themselves are never mutated.

## Feed curation vs shill list

These loops are independent (INV-S22):

| Loop | Decides | Evidence | Mutates |
|---|---|---|---|
| Managed list | Host lifecycle | Lagged settled CA call outcomes | Managed list membership |
| FYP engagement | Runtime agent | Narrative/sentiment utility | Like / follow / unfollow (default ≤2 likes / 10 min; INV-S22 PARTIAL) |

Engagement never writes `source-lifecycle.json` or `sources.json`.

## Review job (`source-list-review`)

Host-only; no Cursor session. Cadence: daily and after a sealed audit.

1. Freeze `scoreCutoff = now`
2. Aggregate lagged performances (`src/sources/outcomes.ts`) when a caller
   supplies outcomes — production review currently passes none
3. Compute promote/demote proposals (`src/sources/lifecycle.ts`)
4. Cap to `max_transitions_per_review` (default 10); queue excess transition
   ids (queued ids are not themselves durable transition records until applied)
5. Commit candidates + applied immutable transitions + pending ids
6. Synchronize X membership to desired managed handles
7. Archive review + sync receipt under the host archive

CLI: `tc source-list review --dry-run` (no state/X writes),
`tc source-list sync` (apply desired membership for the persisted list id).

## Default gates (config-tunable)

**Promote** (probation or re-add after cooldown): ≥10 eligible calls, ≥5 tokens,
≥80% settled coverage, hit mean ≥60%, Wilson 95% LB ≥45%, median 72h excess ≥5%,
rug ≤10%, last eligible call within 14 days.

**Demote** (managed): hard dock immediately; else idle ≥30d; rug >25% with ≥4
settled; or coverage/score below floor for two consecutive review epochs.
Re-add needs cooldown 30d + 5 new eligible calls after demotion.

Demotions sort before promotions. Capacity is `managed_list.capacity`.

## Managed-list synchronizer

- Setup once: `tc auth twitter --create-managed-list` (headed); refuses if
  `list_id` already set. Creation attempts the private toggle when the UI
  exposes it; privacy is not independently verified after create
- Before every mutation: target list id **must equal** persisted managed id
- Snapshot members → deterministic diff → bounded batch → verify after
- Ambiguous failures (timeout, verify miss) record a receipt and retry later;
  never guess membership
- Network allowlist for mutations: GraphQL ops `CreateList`, `ListAddMember`,
  `ListRemoveMember` only (INV-R2)

## Related

- Collectors scrape surface: [collectors.md](collectors.md)
- Job registry: [orchestrator.md](orchestrator.md)
- Playwright profile/auth: [../knowledge/x-playwright.md](../knowledge/x-playwright.md)
- Invariants: INV-S21, INV-R2
