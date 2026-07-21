---
description: Discord chain-integration lane — durable intake, multi-model build, clean gates, fast-forward publish, deploy, announce, research handoff.
scope: module
status: active
last_verified: 2026-07-20
read_when:
  - Editing src/chain-integration/ or chat.discord.chain_integration config.
  - Debugging Discord unknown-chain automation, deploy self-survival, or recovery CLI.
---

# Discord chain integration

Host-owned automation that turns an exact unknown Discord `slug:address` into an
additive chain-registry entry, deploys it, announces success, then resumes the
original request on the normal Discord research FIFO (ADR 016).

## Trigger

- Exact `slug:address` (optional research verb) in configured guild/channels
- Slug must be unknown; address must match evm or base58-32 formats
- Natural language / bare CA never mutate the repo
- Any non-bot channel member may trigger
- Cap: `chat.discord.chain_integration.max_attempts_per_utc_day` (default 3);
  failed attempts consume the cap; joining an in-flight slug does not

## Phases

`queued → collecting → researched → prepared → building → finalizing → gated →
committed → pushed → deploying → deployed → announced → research_queued →
completed` (or `failed`)

State: `~/.trenchcoat/discord/chain-integrations/` (atomic index, journals,
artifacts, `.worker.lock`). Checkpoint after every external call.

## Models (defaults)

| Role | Model | Mode |
|---|---|---|
| Evidence synthesis | `composer-2.5` | plan / read-only |
| Build + repair | `cursor-grok-4.5-high` | write (confined worktree) |
| Docs/tests review | `composer-2.5-fast` | write docs/tests only |

## Confinement

Build may add only:

- `chains/<new-slug>.json`
- `src/lib/chains.generated.ts`
- `tests/unit/chains/<slug>.test.ts`

Finalize may additionally edit:

- `docs/architecture/chains.md`
- `docs/architecture/security-gate.md` (scanner note only)
- the new test file

Existing manifests must stay byte-identical. Wallet tracking stays unsupported.
No scanner → research-only capabilities (`mainTrack: false`); INV-S9 blocks main
tracking.

## Publish / deploy

1. Shared `~/.trenchcoat/repo-mutation.lock`
2. Clean `main == origin/main` base; worktree rebuild once if base moves
3. Fast-forward push candidate SHA to `origin/main`
4. `deployRuntimeFromRepo` → `ops/install-launchd.sh`
5. Health: `deployment.json.sourceCommit`, config schema, listener heartbeat
6. On deploy failure: normal revert commit + `runtime.prev` restore

The chain-integration launchd job is **not** bootout during deploy pause (self-deploy
survival). Drain treats `deploying` as idle-safe; other active phases block idle.

## CLI / launchd

- `tc discord chains run|status|retry|fail|continue`
- `com.trenchcoat.job.discord-chain-integration` (kickstarted by listener)
- Listener only accepts/reacts/kickstarts
- After deploy, worker invokes newly deployed `tc discord chains continue <id>`
  so announcement/handoff see the new registry entry

## Intake / reservation detail

- Discord research placeholder uses status `awaiting-chain` +
  `terminalError: awaiting-chain-integration` so `processNextDiscordRequest`
  never claims it; promote clears that and sets `queued`
- Integration attempt cap (`max_attempts_per_utc_day`) is separate from Discord
  research FIFO; joining an in-flight slug reserves an `awaiting-chain`
  research slot but does not burn another integration attempt. Discord research
  daily/queue-depth caps were removed in schema 16 (ADR 022)
- Build model must be `cursor-grok-4.5-high` (validate with `agent models` —
  bare `cursor-grok-4.5` is not a CLI model id)

## Recovery

| Symptom | Action |
|---|---|
| Stuck mid-phase | `tc discord chains run` (resumes from receipts) |
| Terminal fail, retry | `tc discord chains retry [id]` |
| Operator abort | `tc discord chains fail <id> [reason]` |
| Status | `tc discord chains status` / `tc status` Discord section |

Terminal Discord failure copy (sanitized):
`Could not safely integrate <slug>; the request was not deployed.`

Success copy (exact):
`<Display Name> chain now integrated`
