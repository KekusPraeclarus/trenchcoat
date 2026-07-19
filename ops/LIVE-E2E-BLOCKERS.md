# Live E2E blockers (updated 2026-07-19)

Offline gates (`pnpm test:all`) pass. Credential preflight and live market/gate
smokes run under `TRENCHCOAT_LIVE_E2E=1` when `.env` is loaded.
`live-gates.test.ts` last ran 4 passed / 1 skipped under `TRENCHCOAT_LIVE_E2E=1`
(operator-verified 2026-07-18).

## Deploy state (operator-verified 2026-07-19)

- Env synced: `ops/install-launchd.sh --sync-env` copied `TAVILY_API_KEY` (and
  the rest of `.env`) into `~/.trenchcoat/env` at mode 600, atomically.
- Managed X list created: `list_id 1111111111111111111` (name `trenchcoat-sources`).
- launchd units running after redeploy: broadcast router, Telegram listener, and
  the alpha-channel poller (`com.trenchcoat.router` / `.listener` / `.channels`).
- Telegram preview cursor acceptance confirmed (advanced cursor, no duplicate on
  repoll) and a reversible X unfollow+follow both verified live.
- **2026-07-19:** Telegram overview distill shipped dirty
  (`./ops/install-launchd.sh --allow-dirty`). Live config has
  `broadcast.telegram_overview.enabled=true`. Router healthz ok after kick.
  `tc status` may warn `configSchema` vs runtime expected schema + `DIRTY` until
  a clean commit redeploy — jobs still load. First live overview TG post not yet
  operator-verified (wait for next staged broadcast).

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

## Telegram alpha (operator-verified 2026-07-19)

- Live allowlist flipped to **preview-first** (33 channels). Poller logs
  `preview:33, gramjs:0`; real handles land in `alpha-queue/` (e.g.
  `telegram:cryptolyxecalls`). Stale `alpha-queue/telegram` product-blog junk purged.
- Seed (`config/seed.example.json`) matches: all example channels `mode: "preview"`.
- List-scan now writes `list-scan-alpha-manifest` (paths only) so alpha-queue
  digestion is not review-only. Manifests are capped at 500 items with a
  `truncated=N` marker; backlog above the cap drains across successful digests
  (do not mass-purge). 2026-07-19 afternoon list-scans failed on uncapped
  writes (`too_big`) and Playwright browser-closed mid-scrape; runtime now
  caps the manifest, relaunches the browser once on closed-target death, and
  classifies browser-closed as `collector-error` (not `config-error`).
  Operator-verified recover seal: `list-scan-2026-07-19T15-47-30-155Z`
  (`list-scan-alpha-manifest` items=500 last=`truncated=30`, fresh FYP +
  `x-fyp-eligible`). Alpha-queue stayed ~500 because every agent digest used
  narrative-shaped `items` (Zod reject → `purged=0`); host now records
  `invalidReason=schema-invalid` and chat notes `alphaDigestInvalid` /
  `alphaPurged`. Skills teach the correct `entries` + contentHash contract —
  **sync `agent/skills/list-scan` and `review` into `~/.trenchcoat/agent/skills/`**
  (installer does not), redeploy CLI for prompt/receipt changes, then wait for
  the next list-scan/review. Do **not** mass-delete the queue.
## Still operator-driven

- GramJS channel session auth (`tc auth telegram-channels`): still unfinished.
  Preview covers the public allowlist; preview-disabled channels need a live
  MTProto session **and** a GramJS listener injection the CLI does not provide
  yet. Missing session warns and idles (no crash).
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
- **Fomo** — adapters + host jobs landed (`fomo-trader-sync`,
  `fomo-signal-scan`, `fomo-x-source-review`, `fomo-narrative-source-scan`,
  `narrative-source-review`) with fail-closed defaults. **Not live yet:**
  code may still be local/uncommitted; FAFO probe is a scaffold
  (`pnpm probe:fomo`) until burner `auth fomo` + discover/sanitize/evaluate
  install gates with provider `pass`. Then 14-day shadow
  (`ops/fafo-fomo/SHADOW-CANARY.md`) before `shadow_mode: false`. Optional
  read-only: `TRENCHCOAT_LIVE_FOMO=1 pnpm vitest run tests/e2e/fomo-live.test.ts`.
  See `ops/fafo-fomo/REPORT.md` + [knowledge/fomo-family.md](../docs/knowledge/fomo-family.md).

## Deploy provenance / canary (docs only — not executed here)

Install requires a clean git commit by default (`ops/install-launchd.sh`). Dirty
trees need `--allow-dirty`; the resulting `deployment.json` records
`sourceDirty=true` and a deterministic `sourceHash`, and `tc status` warns.
Canary after install: status provenance + schema → FC (no engagement) →
narrative-scan → organic list-scan X settlement → canary broadcast +
delivery-retry → review health snapshot; FOMO stays shadow. Rollback via
`runtime.prev` (+ config backup); do not delete receipts. Full sequence:
`ops/runbook.md` § Deploy canary and rollback.

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
