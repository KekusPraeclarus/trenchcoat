---
description: ADR — Archive journal and run receipts are authoritative; periodic Git is backup-only.
status: accepted
date: 2026-07-17
---

# ADR 006 — Archive-authoritative journal and receipts

## Context

Earlier drafts treated a per-run Git commit of `~/.trenchcoat/agent` as the
durability gate for completed runs (INV-S8/S11). That conflates backup with
transaction authority, races with crash resume, and puts Git on the critical
path for alpha purge and egress.

Operator decisions for the remaining gaps:

1. Authoritative completed-run durability is an **archive + fsynced journal**,
   with periodic Git backup.
2. Host-owned typed receipts live under `archive/runs/<run-id>/`; agent outputs
   remain proposals.
3. Recovery is **deterministic journal resume** with quarantine on hash conflict —
   no recovery-model session and no silent conflict resolution.

## Decision

1. The authoritative run journal is
   `~/.trenchcoat/archive/transactions/<run-id>.json`, written with atomic
   rename and best-effort fsync. An agent-side journal under
   `agent/reports/<run-id>/journal.json` is diagnostic only.
2. Pre-session inbox copies, manifests, verifier reports, validation receipts,
   alpha-digest receipts, broadcast rejects, delivery receipts, and incidents
   are written under `archive/runs/<run-id>/`.
3. External effects (alpha purge, router delivery, X mutations) occur only after
   verifier success and archive seal, keyed by journal side-effect hashes.
4. Conflicting phase or side-effect hashes move the run into
   `archive/quarantine/<run-id>/` and refuse auto-resume.
5. Periodic Git backup (`ops/backup.sh` / `tc backup`) remains available and
   never gates completion.
6. Journal `status` is `running | complete | failed`. Interrupted or errored
   runs are marked `failed` (terminal); `findIncompleteRuns` only resumes
   `running` journals. Failed runs are not auto-resumed.
7. **Legacy compatibility (post-ADR):** pre-status archive journals are accepted
   in-memory only — `phase: "complete"` ⇒ `status: "complete"`, otherwise
   `running` (or `failed` when a `failure` object is present). Historical files
   are not rewritten. Bulk narrative/review scans isolate corrupt journals;
   direct load/resume remains strict. Legacy `phase: "created"` journals older
   than six hours are reported abandoned and never auto-resumed.

## Consequences

- INV-S8 verification points at archive seal, not per-run Git.
- Wired in `run.ts` / `journal-store.ts`: seal before purge/egress; quarantine on
  hash conflict; `markRunFailed` on mid-flight errors; `findIncompleteRuns` for
  resume (resume depth still PARTIAL). Legacy status derivation lives in
  `tryParseJournal` / `loadJournalForScan`.
- `archive/runs/<run-id>/journal.json` is a seal-time copy only (frozen at
  `host-prepared`); terminal status lives in `transactions/` — see
  orchestrator.md / snapshot-archive.md.
- Rollback/recovery reads the last completed archive transaction, not arbitrary
  Git HEAD.
