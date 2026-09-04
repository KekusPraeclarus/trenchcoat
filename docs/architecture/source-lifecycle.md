---
description: Host-owned FYP/X source candidacy and managed private list (ADR 004), Fomo dual-track X curation (ADR 009 / ADR 048), plus Farcaster follow-graph lifecycle (ADR 007).
scope: module
status: active
last_verified: 2026-09-04
read_when:
  - Editing src/sources/, src/collectors/twitter/managed-list.ts, src/collectors/farcaster/, or source-list / fc-source-list orchestration.
  - Changing promotion/demotion thresholds or X list / FC follow-graph membership behaviour.
---

# Source-list lifecycle

## Purpose

Discover promising X accounts from the FYP, score them from settled call
outcomes, and keep one managed list in sync — without ever letting a
model choose members or mutate X.

Binding decision: [ADR 004](../adr/004-dynamic-x-list-lifecycle.md).

**Current limit:** `runSourceListReview` loads archive `source-call` outcomes when
present (`src/orchestrator/sources.ts` via `source-list.ts`), applies lagged
scores into `sources.json` for candidates with `settledCalls > 0`, and runs on
launchd daily (`RunAtLoad` + 24h) plus after a sealed audit. Headline settlement
is peak% from entry (quiet 6h / 14d force; ADR 032). Empty archives still
yield no promotions (INV-S21). Prefer `tc source-list review --dry-run` until
sealed outcomes accumulate.

## State

| File | Owner | Role |
|---|---|---|
| `agent/state/sources.json` | host | Per-source quality scores (audit / dock) |
| `agent/state/source-lifecycle.json` | host | FYP candidates, immutable transitions, pending sync ids, managed list id |

Integrity snapshots include `source-lifecycle.json` (INV-S7 family). The agent
must not write either file.

## Fomo leaderboard → dual-track X curation

Binding decision: [ADR 009](../adr/009-fomo-x-source-nomination.md).

| File | Owner | Role |
|---|---|---|
| `agent/state/x-source-nominations.json` | host | Pending Fomo→X nominations from explicit profile X links |
| `agent/state/x-narrative-sources.json` | host | Narrative utility probation / follow eligibility |
| `agent/state/fomo-follows.json` | host | FOMO-platform follows for feed buys (ADR 048). Failed follows cool 24 hours. |

- `discoveredFrom: "fomo-leaderboard"` enters `source-lifecycle.json` only after
  deterministic historical X-post call extraction meets shiller thresholds
  (10 calls / 5 tokens). FOMO profile buys do not count. Only X-post CAs enter
  the call log. Promotion scores those X-post outcomes. FOMO traders score on
  FIFO `fomo-trader-scores.json`. Tickers and FOMO profile wallets do not count.
- Classification agent output never mutates lists or follows. Shiller and
  narrative tracks graduate independently (`both` must pass both).
- Historical posts are never reused as live narrative evidence.

## Pump.fun follow graph (feed training)

Binding decision: [ADR 047](../adr/047-pump-feed-scan.md).

Pump likes and follows train the Pump FYP/Top/News feed. They do not write
the X managed list or `source-lifecycle.json`. Follow evidence is Pump UI
call charts plus settled `pump-caller-scores.json`. Profile ids never enter
`wallets.json`.

## Farcaster follow-graph (parallel)

Binding decision: [ADR 007](../adr/007-farcaster-follow-graph.md).

| File | Owner | Role |
|---|---|---|
| `agent/state/fc-source-lifecycle.json` | host | FC candidates (`fc_*`), transitions, pending sync ids |
| `agent/state/fc-engagement.json` | host | Like receipts / throttle state (agent proposes only) |

`farcaster-scan` discovers from for-you + operator channels. Promotion/demotion
gates mirror X. Sync mutates the bot follow graph only for fids present in
lifecycle state (fid confinement). Agent may propose likes, never follows.

When the following feed is empty and `desiredFollowFids` length is 0, collection
status is `healthy-empty-following` (not an error). Non-zero desired membership
with an empty following feed is `empty-following-with-desired`. Signer mutations
are gated by `probeFarcasterSigner` — collection status reports
`signerStatus=<approved|pending|rejected|unavailable>` and
`signerMutations=allowed|blocked`; likes and follow sync perform no mutation
until `approved`. For-you freshness: live ≤6h / stale ≤24h / expired >24h;
future-dated casts (e.g. 2061 timestamps) count as expired. No live casts or the
repeated-two-hash stale pattern rejects for-you and sets
`engagementDisabled=true` (likes stay off). `skipAgent=true` only when every
bounded FC source including trending fallback is unusable — otherwise the
agent may still run as `analysis-only` on fallback/following evidence.

Operator bootstrap for a curated follow graph:

1. `tc auth farcaster` — create or attach signer; approve in mobile app or fund
   custody for host `KeyGateway.add`
2. `tc fc-source seed <file> --dry-run` then `tc fc-source seed <file>`
3. `tc fc-source sync --dry-run` then `tc fc-source sync`
4. `tc probe farcaster` — verify signer status, feed freshness, lifecycle summary

Seed schema: `config/fc-source-seed.example.json` (positive FIDs, normalized
handles; never accepts signer material or model/inbox content).

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
| FYP engagement | Runtime agent | Narrative/sentiment utility | Like / follow / unfollow (likes must target same-run FYP post ids; default ≤2 likes / 10 min; INV-S22 PARTIAL) |

The host writes `inbox/<run-id>/x-fyp-eligible.json` during `list-scan`
collection — a manifest of FYP post ids and authors eligible for engagement.
The bot must propose only targets from that manifest; the host rejects anything
else (`post_id_not_in_fyp`, `handle_not_in_fyp`). After FYP binding the host also
rejects choices already reflected in subscription state or still pending, so a
replayed proposal never re-attempts a settled action:

| Reject reason | Applies to | Condition |
|---|---|---|
| `already_liked` | like | post in `likedPostIds` or a verified like receipt exists |
| `already_following` | follow | handle already in `followedHandles` (case-insensitive) |
| `not_following` | unfollow | handle not in `followedHandles` |
| `pending_duplicate` | any | same action+target has an accepted decision whose `actionId` is still pending |

These are runId-independent and never bump `daily.*`. Execution health is tracked
in `state/x-bot-health.json` (last verified action, consecutive failures).

Engagement never writes `source-lifecycle.json` or `sources.json`.

## Review job (`source-list-review`)

Host-only; no Cursor session. Cadence: daily and after a sealed audit.

1. Freeze `scoreCutoff = now`
2. Register strong X-post callers (≥10 calls, ≥5 tokens) who also appear on a
   sealed FYP or operator-list snapshot. Home-only callers stay out.
3. Aggregate lagged performances (`src/sources/outcomes.ts`) from archive
   `source-call` outcomes when present (`loadSourceCallOutcomes`). Promotion
   drops FOMO profile-swap keys. Empty archives yield no promotions.
4. Compute promote/demote proposals (`src/sources/lifecycle.ts`)
5. Cap to `max_transitions_per_review` (default 10); queue excess transition
   ids (queued ids are not themselves durable transition records until applied)
6. Commit candidates + applied immutable transitions + pending ids
7. Synchronize X membership to desired managed handles
8. Archive review + sync receipt under the host archive

CLI: `tc source-list review --dry-run` (no state/X writes),
`tc source-list sync` (apply desired membership for the persisted list id).

## Default gates (config-tunable)

**Promote** (probation or re-add after cooldown): ≥10 eligible calls, ≥5 tokens,
≥80% settled coverage, hit mean ≥60%, Wilson 95% LB ≥45%, median peak excess ≥5%,
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
- Neynar / FC auth: [../knowledge/neynar.md](../knowledge/neynar.md)
- Invariants: INV-S21, INV-R2
