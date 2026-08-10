---
title: "044 — Alpha-ack relocation and retention"
status: accepted
date: 2026-08-10
last_verified: 2026-08-10
---

# ADR 044: Alpha-ack relocation and retention

## Context

ADR 034 introduced host alpha acks: `classifyAlphaMessage` writes a small
tombstone per no-thesis alpha-queue message so the digest receipt has a durable
`state/` record and INV-Q1 can purge the queue file. The tombstones lived under
`state/research/alpha-ack-<channel>-<messageId>.md` and nothing ever deleted
them. After three weeks live the directory held ~2,800 tombstones against ~80
real token dossiers. The clutter slowed and polluted every job that reads
`state/research/*.md` for context (review, list-scan, telegram-alpha), and the
file count grew without bound.

After purge, nothing reads a tombstone again. The archived
`alpha-digest-receipt.json` under the run archive records channel, messageId,
message hash, record path, and record hash — the tombstone body is fully
reconstructable from it. The telegram collector dedupes with its own cursor
file, so a purged message cannot re-enter the queue.

## Decision

1. **Relocate.** `alphaAckRelPath` returns
   `state/alpha-acks/<channel>-<messageId>.md`. The digest record schema
   already accepts any `state/` path; purge validation is unchanged.
   `state/research/` holds token dossiers only. Skills instruct the agent to
   use the same directory.
2. **Sweep.** Workspace retention (`retainAlphaAckTombstones`) deletes a
   tombstone only when **both** hold: its age exceeds
   `retention.alpha_ack_days` (config schema 25, default 30), and its
   `alpha-queue/<channel>/<messageId>.json` no longer exists (purge completed).
   A pending message keeps its tombstone at any age.
3. **Legacy drain.** The sweep also matches the legacy
   `state/research/alpha-ack-*.md` pattern with the same guards. The live
   backlog drains on the first lock-holding runs; no one-shot migration.
4. **Invariant wording.** INV-Q2 holds at purge time. After purge, the archived
   digest receipt is the durable record, so the sweep destroys no knowledge.

## Consequences

- `state/research/` stays a clean dossier directory; agent context reads
  improve.
- Retention runs at the `events-staged` phase, after the same run's purge, and
  only in agent-lock lanes. The report gains `alphaAcksRemoved`.
- The receipt-not-tombstone record depends on archive retention
  (`retention.run_archive_days`, default 90) exceeding `alpha_ack_days`
  (default 30). Operators who shrink archive retention below the ack window
  give up the post-purge record for those runs.
- Skill edits require a skills sync to the live agent home before live jobs
  pick them up.
