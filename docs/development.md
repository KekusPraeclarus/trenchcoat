---
description: Developer workflow notes — parallel worktrees, shared-file merge ownership, and how to keep docs honest while coding.
scope: project
status: active
last_verified: 2026-07-16
read_when:
  - Merging parallel feature worktrees or coordinating multi-agent integration.
  - You need the exclusive-ownership list for shared integration files.
---

# Development workflow

## Parallel feature worktrees

When several feature branches land into one integration branch:

1. **Exclusive merge ownership** — one integration owner merges these files;
   others must not rewrite them in parallel:
   - `package.json` / lockfile
   - `src/contracts/**`
   - `src/orchestrator/run.ts`
   - `docs/INVARIANTS.md`
2. **Cherry-pick** non-overlapping module files freely.
3. **Reconcile** duplicate APIs / schema fields before declaring the integration
   green (`pnpm test:all`).
4. Behaviour changes update the matching `docs/` file in the same change and
   bump `last_verified`.

## Context graph

Start at [README.md](README.md). Surprises go into [gotchas.md](gotchas.md);
drain during context maintenance. Probe suite: [../ops/context-probes.md](../ops/context-probes.md).
