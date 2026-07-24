---
description: ADR — Telegram operator chat may run one-off /plan and /agent turns against the git checkout.
status: accepted
date: 2026-07-24
last_verified: 2026-07-24
---

# ADR 040 — Telegram remote code-agent directives

## Context

Operator Telegram chat was a durable `composer-2.5` ask-mode session confined
to `~/.trenchcoat/agent` with sandbox enabled. That is correct for knowledge
recall, but it blocks remote coding while away from a desktop IDE. The operator
needs per-message model and mode overrides, including a tool-enabled agent turn
over the deployed git checkout, and accepts that this deliberately weakens
isolation invariants for that path.

## Decision

1. **Leading directives only.** Host parsing consumes whitespace-separated
   directives at the start of a private allowlisted DM. Last-wins within model
   and within mode. Directives mid-message stay ordinary text. Directive-only
   messages return help and never open Cursor.
2. **Mappings.**
   - `/model-high` → `gpt-5.6-sol-low`
   - `/model-mid` → `gpt-5.6-terra-medium`
   - `/model-low` → `cursor-grok-4.5-high`
   - `/plan` → `--mode plan` on the checkout (`TRENCHCOAT_REPO_ROOT`)
   - `/agent` → omit `--mode`, `--sandbox disabled`, `--force` on the checkout
3. **Default unchanged.** No directive ⇒ durable resumable ask chat,
   `composer-2.5`, sandbox enabled, `~/.trenchcoat/agent`.
4. **One-off overrides.** Any model or mode override skips `--resume` and does
   not mutate `chat-session.json`, so a temporary mode cannot stick.
5. **Checkout resolution.** `/plan` and `/agent` resolve only
   `TRENCHCOAT_REPO_ROOT` (absolute, realpath, `.git` + `package.json` +
   `ops/` + `docs/`). Never accept a path from Telegram text.
6. **Authorization boundary.** `TELEGRAM_OPERATOR_ID` allowlist + private DM
   remains the sole authorization gate (INV-B3). Child env stays scrubbed
   (`scrubChildEnv`). With sandbox disabled, scrubbing does **not** prevent
   reading host files such as `~/.trenchcoat/env`.
7. **Ask never auto-promotes.** Tool-enabled mode requires an explicit
   leading `/agent`.

## Consequences

- Easier: remote coding and planning from Telegram without a desktop session.
- Harder: INV-I1/I2/I5 gain an explicit operator chat exception; a compromised
  Telegram account or prompt-injection against an `/agent` turn has broad
  checkout and host filesystem authority.
- Unchanged: research confirm/cancel, remediation approvals, broadcast fanout,
  and default ask chat.

## Alternatives considered

- Confirm-gated worktree remediation-style lane: safer, but not interactive
  IDE-like turns.
- Widening every chat turn to the checkout: changes default recall behaviour.
- Passing host credentials into the child: rejected; keep scrubbing.

## Follow-ups

- Redeploy the listener runtime after merge (`ops/install-launchd.sh` /
  `ops/install-systemd.sh`) so live Telegram picks up the new path.
- Optional later: higher-risk path denylist or worktree confinement for
  `/agent` if the blast radius proves too large in practice.
