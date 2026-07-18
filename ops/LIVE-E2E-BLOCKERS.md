# Live E2E blockers (updated 2026-07-18)

Offline gates (`pnpm test:all`) pass. Credential preflight and live market/gate
smokes run under `TRENCHCOAT_LIVE_E2E=1` when `.env` is loaded.
`live-gates.test.ts` last ran 4 passed / 1 skipped under `TRENCHCOAT_LIVE_E2E=1`
(operator-verified 2026-07-18).

## Deploy state (operator-verified 2026-07-18)

- Env synced: `ops/install-launchd.sh --sync-env` copied `TAVILY_API_KEY` (and
  the rest of `.env`) into `~/.trenchcoat/env` at mode 600, atomically.
- Managed X list created: `list_id 1111111111111111111` (name `trenchcoat-sources`).
- launchd units running after redeploy: broadcast router, Telegram listener, and
  the alpha-channel poller (`com.trenchcoat.router` / `.listener` / `.channels`).
- Telegram preview cursor acceptance confirmed (advanced cursor, no duplicate on
  repoll) and a reversible X unfollow+follow both verified live.

## Cursor agent (required for live jobs)

Use the [Cursor CLI](https://cursor.com/docs/cli/installation), not an API key:

```bash
curl https://cursor.com/install -fsS | bash
agent login
agent status   # must show Logged in as …
```

Optional: `TRENCHCOAT_CURSOR_BIN` if `agent` is not on PATH.

Production launch path: host Cursor CLI with `--sandbox enabled` (see
`src/orchestrator/session.ts`). Docker `containers/agent-runner` is
reference/defense-in-depth only — not the production isolation boundary.

## Present locally (do not commit secrets)

- Node ≥22.13, pnpm
- Cursor CLI logged in
- `.env` with router / Telegram / Helius / Infura / GoPlus / CoinGecko / Neynar keys
- `~/.trenchcoat/config.json` and Twitter `storage-state.json` (from `tc auth twitter`)
- Optional: Docker image for reference compose checks only

## Still operator-driven

- GramJS channel session auth (`tc auth telegram-channels`): the `com.trenchcoat.channels`
  poller runs on preview channels now, but preview-disabled channels need a live
  MTProto session. Missing session warns and idles (no crash) until authed.
- Managed-list sync and engagement dry-runs (list itself now created, above):
  - `pnpm dev:cli source-list review --dry-run`
  - `pnpm dev:cli x-engagement dry-run <run-id>`
- Scheduling real live jobs (list-scan, research, chat confirmations)
- Residual X follow edge cases — Phase 3C live-verified follow
  (`example_handle` on `list-scan-2026-07-18T18-36-02-564Z`); some profiles may
  still hit `account_not_followable` or `pending_duplicate` (INV-S22)
- Live isolation (`TRENCHCOAT_LIVE_ISOLATION=1`) operator-green 2026-07-18:
  escape write-block, network-deny, and prompt-injection probes all passed.
  INV-I1 remains PARTIAL because Cursor CLI still allows outside **reads**;
  write confinement + `disableTmpWrite` + scrubbed child env are the enforced bar.
  INV-I5 container smoke remains reference-only / PARTIAL.

## Commands

```bash
# Offline (includes structural isolation asserts)
pnpm test:all

# Isolation: structural always + live probes when CLI authenticated
TRENCHCOAT_LIVE_ISOLATION=1 pnpm test:live:isolation

# Credential + live OHLCV/gate smokes (load .env first)
set -a && source .env && set +a
TRENCHCOAT_LIVE_E2E=1 pnpm test:e2e:live
```
