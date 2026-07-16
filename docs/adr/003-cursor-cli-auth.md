---
description: ADR — trenchcoat drives Cursor via CLI login, not @cursor/sdk API keys.
status: accepted
date: 2026-07-16
---

# ADR 003 — Cursor CLI login auth

## Context

Early drafts assumed `@cursor/sdk` with an explicit `CURSOR_API_KEY`. The
operator already runs headless Cursor agents in other projects via the
[Cursor CLI](https://cursor.com/docs/cli/installation) (`agent` /
`cursor-agent`) authenticated with `agent login` — no API key issued or desired.

## Decision

- Primary harness: spawn `agent -p --trust --sandbox enabled --workspace <agent/>
  --model composer-2.5` from `src/orchestrator/session.ts`
- Auth: operator CLI session (`agent login` / `agent status`). Do not require
  `CURSOR_API_KEY`
- Optional `--api-key` / env only as an escape hatch; never the documented path
- Do not depend on `@cursor/sdk` in `package.json`
- Binary resolution: `TRENCHCOAT_CURSOR_BIN`, else `~/.local/bin/agent`, else
  `cursor-agent` / PATH

## Consequences

- Preflight checks CLI install + (for live) login status, not an API key
- Live E2E blockers list CLI login separately from provider secrets
  (`ops/LIVE-E2E-BLOCKERS.md`)
- Knowledge file: `docs/knowledge/cursor-cli.md` (replaces cursor-sdk.md)
- Outer container isolation (INV-I5) remains mandatory; CLI `--sandbox` alone
  does not satisfy host-path isolation
