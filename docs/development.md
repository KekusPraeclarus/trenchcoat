---
description: Developer workflow notes — parallel worktrees, shared-file merge ownership, and how to keep docs honest while coding.
scope: project
status: active
last_verified: 2026-08-18
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

`SnapshotWriter` / `assertPathInside` reject paths whose `realpath` escapes the
agent root (INV-I4). On macOS, `os.tmpdir()` often returns `/var/folders/...`
while `realpath` resolves `/private/var/folders/...` — `assertInsideRoot` in
`src/lib/snapshot.ts` realpaths the root and walks missing parents so temp
fixtures work; still prefer `realpathSync` on agent roots when constructing
writers by hand.

With `exactOptionalPropertyTypes`, Zod-inferred `field?: T` is not assignable
to `field?: T | undefined` receivers when the value may be missing — prefer
conditional spreads (`...(x.framing !== undefined ? { framing: x.framing } : {})`)
or annotate helper params as `T | undefined`.

Host precondition skips call `ensureArchive`, which creates empty layout dirs
(`runs/`, `transactions/`, …) even when no run is allocated. Assert those dirs
are empty (or that no journal/inbox/report exists), not that the dirs are absent.

Live FS-escape isolation probes must use a **non-tmp** layout (e.g.
`~/.trenchcoat/isolation-probes/`) with `disableTmpWrite: true` — see
[knowledge/cursor-cli.md](knowledge/cursor-cli.md).

`systemClock` is `Object.freeze`d — do not `vi.spyOn(systemClock, "nowIso")`.
Prefer fixture timestamps that match the calendar day under test.

Adding a new orchestrator module that calls `writer.writeInbox` requires updating
the allowlist in `tests/redteam/static.test.ts` (`prop_inv_i4_inbox_writer_ownership`).

## Fomo probe / gates

```bash
pnpm dev:cli auth fomo
pnpm tsx scripts/smoke-fomo-live.ts
pnpm fomo:install-gates ops/fafo-fomo/gates.operator-override-2026-09-04.json
# or fail-closed seed: ops/fafo-fomo/gates.seed.json
pnpm fomo:shadow-metrics --day $(date -u +%F)
```

`pnpm probe:fomo` is discover/status/sanitize only (no `evaluate`). Prefer the
live smoke script before installing gates. Shadow/canary:
[../ops/fafo-fomo/SHADOW-CANARY.md](../ops/fafo-fomo/SHADOW-CANARY.md).
Mutation of wallets / research queue / X nominations requires gates `pass`,
`fomo.enabled=true`, and `shadow_mode=false` (shadow first when graduating).

`tests/redteam/static.test.ts` INV-I4 ownership: a file that *reads*
`agent/inbox` and also `writeAtomicFile`s elsewhere is not an inbox writer —
the check requires `writeInbox` / inbox `mkdirSync`, not mere `join(..., "inbox")`.

## Static lint (`scripts/lint-static.ts`)

Signing/wallet SDKs (`viem`, `ethers`, …) are banned under `src/` except the
host-only Farcaster custody path `src/collectors/farcaster/signer.ts` (ADR 007 /
INV-A1). Do not broaden that allowlist for trade or agent-mounted code.

## Secret scan (gitleaks)

Install the CLI with `brew install gitleaks`. On Linux, install the GitHub
release binary. Run `pnpm secret-scan` before you push. CI runs the same
check on pull requests and on `main` (`.github/workflows/gitleaks.yml`).
Config lives in `.gitleaks.toml`. The `generic-api-key` allowlist covers
only mint and CA shapes in `tests/` and `docs/`. It also covers one fake
Privy JWT in `tests/unit/pump-auth.test.ts`. A real `HELIUS_API_KEY`
assignment in a test still fails. Mutation-lane `secret-scan` prefers
`gitleaks dir` on the worktree. It uses the assignment regex when gitleaks
is missing (INV-I3).

## Git ignore

A public clone must not contain runtime data, secrets, or operator seeds.
`.gitignore` drops build output, `.env`, agent inbox/reports, local VPS sync
(`.trenchcoat-remote/`), and operator-only config. Empty `agent/state`
scaffold files stay tracked. Before the first public push, drop already
tracked operator files from the index (working copies stay):

```bash
git rm --cached config/operator-candidates-pons-robinhood.json \
  ops/fafo-fomo/gates.operator-override-2026-07-19.json \
  ops/fafo-pump/gates.shadow-live.json \
  ops/NOTES.md
```

## Context graph

Start at [README.md](README.md). Surprises go into [../ops/gotchas.md](../ops/gotchas.md);
drain during context maintenance. Probe suite: [../ops/context-probes.md](../ops/context-probes.md).
