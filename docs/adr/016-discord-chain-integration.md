---
description: ADR — Discord may enqueue a host-owned chain-integration lane that mutates additive chain manifests and deploys after deterministic gates.
scope: project
status: accepted
last_verified: 2026-07-20
---

# ADR 016 — Discord-triggered host chain integration

## Context

Unsupported `slug:address` requests in Discord previously failed closed at
intent. Operators asked for safe automation that researches a chain, adds it to
the registry, deploys, then resumes normal Discord research — without letting
untrusted Discord/provider text choose files, git commands, scanners, or deploy.

INV-D1 isolates Discord research agents from main state. INV-S24 confines
harness improvement to decision-policy only and forbids origin push. Widening
either would conflate advisory research with repository mutation.

## Decision

- Exact unknown `slug:address` (optional research verb) in configured guild
  channels may enqueue a **host-owned** chain-integration job under
  `~/.trenchcoat/discord/chain-integrations/`.
- Listener accepts, reacts ✅, reserves normal research quota via Discord request
  status `awaiting-chain` (so the research pump never claims the placeholder),
  and kickstarts `tc discord chains run`. It never deploys itself.
- Evidence collection and gate/publish/deploy are host-deterministic. Models
  receive only host-validated artifacts. Mutation agents are confined to additive
  `chains/<slug>.json`, generated registry output, new unit tests, and narrow docs.
- Build model id is `cursor-grok-4.5-high` (not bare `cursor-grok-4.5` — that id
  is absent from `agent models`).
- Publication is a normal fast-forward push to `origin/main` after clean gates.
  Deploy uses `ops/install-launchd.sh`. Failure may normal-revert + `runtime.prev`.
- After deploy, announcement + research handoff run via the **newly deployed**
  CLI (`tc discord chains continue <id>`), not the pre-deploy worker process —
  otherwise `DiscordChainSchema` / generated slugs lack the new chain.
- Success copy is exactly `<Display Name> chain now integrated`, then handoff
  into the existing Discord research FIFO without a second quota charge.
- Config schema **12** adds `chat.discord.chain_integration`.
- **INV-D2**: Discord may only enqueue this lane; no untrusted value directly
  chooses mutation/deploy. **INV-S26**: additive chain publication lane (INV-S24
  remains harness-policy-only).

## Alternatives considered

- **Widen INV-S24 / harness lane** — rejected; decision-policy confinement must
  stay narrow; chain manifests are a different mutation class.
- **Let Discord agent edit the repo** — rejected; Discord/provider text is
  attacker-controlled (INV-D1 / INV-D2).
- **In-process announce after deploy** — rejected; pre-deploy binary lacks the
  new registry slug for typed handoff.
- **Manual-only registry edits** — retained as the operator path; automation is
  additive for Discord exact-match triggers only.

## Consequences

- Discord becomes a trigger surface for repository mutation, but only through
  fail-closed host gates.
- Daily UTC attempt cap (default 3) and research-quota reservation apply; failed
  attempts consume the integration cap; joining an in-flight slug does not.
- Research-only chains (no scanner) may deploy; INV-S9 still blocks main tracking.
- Wallet/Fomo support stays off for automated integrations.
- Self-deploy: chain-integration launchd job is not bootout during deploy pause;
  drain treats phase `deploying` as idle-safe to avoid deadlock with
  `wait_for_agent_idle`.
- Operators must keep schema 12 aligned across `ConfigSchema`,
  `DEPLOYMENT_CONFIG_SCHEMA`, and `install-launchd.sh` `configSchema` (same as
  any schema bump — P32).

## Follow-ups

- Live canary of a new fixture chain with real Dex/Gecko (+ GoPlus when claimed).
- Strengthen INV-S26 verification toward ENFORCED as crash/replay coverage grows.

## References

- [architecture/discord-chain-integration.md](../architecture/discord-chain-integration.md)
- [architecture/chains.md](../architecture/chains.md)
- [knowledge/discord.md](../knowledge/discord.md)
- INV-D1 / INV-D2 / INV-S26 in [INVARIANTS.md](../INVARIANTS.md)
- ADR 010
