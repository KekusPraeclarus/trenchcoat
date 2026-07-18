---
description: Developer workflow notes — parallel worktrees, shared-file merge ownership, and how to keep docs honest while coding.
scope: project
status: active
last_verified: 2026-07-18
read_when:
  - Merging parallel feature worktrees or coordinating multi-agent integration.
  - You need the exclusive-ownership list for shared integration files.
  - Writing fixture tests that use SnapshotWriter / temp agent roots on macOS.
---

# Development workflow

## Parallel feature worktrees

When several feature branches land into one integration branch:

1. **Exclusive merge ownership** — one integration owner merges these files;
   others must not rewrite them in parallel:
   - `package.json` / lockfile
   - `src/contracts/**`
   - `src/orchestrator/run.ts`
   - `src/orchestrator/collect.ts`
   - `docs/INVARIANTS.md`
2. **Cherry-pick** non-overlapping module files freely.
3. **Reconcile** duplicate APIs / schema fields before declaring the integration
   green (`pnpm test:all`).
4. Behaviour changes update the matching `docs/` file in the same change and
   bump `last_verified`.

## Test fixtures (macOS)

`SnapshotWriter` rejects inbox paths whose `realpath` escapes the agent root
(INV-I4). On macOS, `os.tmpdir()` often returns `/var/folders/...` while
`realpath` resolves `/private/var/folders/...` — wrap temp agent roots with
`realpathSync` before constructing `SnapshotWriter` or `collectForJob`, or
writes fail with `Symlink escapes sandbox root`.

Host precondition skips call `ensureArchive`, which creates empty layout dirs
(`runs/`, `transactions/`, …) even when no run is allocated. Assert those dirs
are empty (or that no journal/inbox/report exists), not that the dirs are absent.

`systemClock` is `Object.freeze`d — do not `vi.spyOn(systemClock, "nowIso")`.
Prefer fixture timestamps that match the calendar day under test.

Adding a new orchestrator module that calls `writer.writeInbox` requires updating
the allowlist in `tests/redteam/static.test.ts` (`prop_inv_i4_inbox_writer_ownership`).

## Static lint (`scripts/lint-static.ts`)

Signing/wallet SDKs (`viem`, `ethers`, …) are banned under `src/` except the
host-only Farcaster custody path `src/collectors/farcaster/signer.ts` (ADR 007 /
INV-A1). Do not broaden that allowlist for trade or agent-mounted code.
## Context graph

Start at [README.md](README.md). Surprises go into [gotchas.md](gotchas.md);
drain during context maintenance. Probe suite: [../ops/context-probes.md](../ops/context-probes.md).
