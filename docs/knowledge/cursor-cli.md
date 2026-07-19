---
description: Provider knowledge — Cursor CLI local agent (login auth, not API key).
scope: project
status: active
last_verified: 2026-07-19
---

# Cursor CLI

Install: [cursor.com/docs/cli/installation](https://cursor.com/docs/cli/installation)

```bash
curl https://cursor.com/install -fsS | bash
# ensure ~/.local/bin is on PATH
agent login
agent status   # must show Logged in as …
```

Binding decision: [ADR 003](../adr/003-cursor-cli-auth.md).

## trenchcoat harness

- Binary: `agent` (symlink also appears as `cursor-agent`) under `~/.local/bin`
- Override: `TRENCHCOAT_CURSOR_BIN`
- Headless jobs: `agent -p --trust --sandbox enabled --workspace <abs agent/> --model composer-2.5 --output-format text`
- Operator Telegram chat: same, plus `--mode ask --output-format stream-json --stream-partial-output` (assistant text deltas → Telegram `sendMessageDraft`)
- Auth: operator CLI login — **not** `CURSOR_API_KEY` (production paths never pass `--api-key`)
- Chat follow-ups: `--resume <chatId>` / `--continue`
- Never interpolate scraped text into the prompt — path references only
- Production isolation boundary is host CLI `--sandbox enabled` + scrubbed child env;
  Docker `containers/agent-runner` is reference/defense-in-depth only (INV-I1/I2/I5)

## Filesystem confinement (session-verified 2026-07-18)

Source: live `TRENCHCOAT_LIVE_ISOLATION=1` probes against `agent -p --sandbox enabled`.

- `agent/.cursor/sandbox.json` must set `disableTmpWrite: true` (synced into
  `~/.trenchcoat/agent` on deploy). Without it, `/tmp` and macOS `/var/folders`
  look like successful outside writes.
- **Writes** outside the workspace are denied on a home-layout probe
  (`~/.trenchcoat/isolation-probes/…`).
- **Reads** outside the workspace still succeed (relative `../` and absolute
  paths). Treat INV-I1 as write-confined + env-scrubbed, not full FS isolation.
- Isolation probes that only use `os.tmpdir()` are invalid for write claims.

## Auth pitfalls (verified against other local CLI harnesses)

Source: operator correction + patterns from a sibling project that already drives
`agent` headlessly. Verification: `agent status` on this machine shows login;
`@cursor/sdk` was removed from the lockfile.

- Do **not** require or document `CURSOR_API_KEY` as the primary path — the
  operator may not have one and already uses CLI login elsewhere
- When spawning, prefer the real user home for CLI auth artifacts if the host
  process ever redirects `HOME` (detection and spawn must agree)
- Strip unrelated provider keys from the child env if the host injects them for
  other collectors — otherwise the CLI can pick the wrong credential surface
- Preflight: `agent --version` always; `agent status` / logged-in check for live

## Models

Default pin: `composer-2.5`. Override via session options / future config only
after an explicit doc+config change.
