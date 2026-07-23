---
description: Provider knowledge — Telegram preview and GramJS listener.
scope: project
status: active
last_verified: 2026-07-20
---

# Telegram

- Preview mode via `t.me/s` fixtures/parsers — preferred for public alpha channels
- GramJS for preview-disabled channels only (scaffold; CLI does not inject the
  listener yet; needs `~/.trenchcoat/telegram-session/session.txt`)
- FLOOD_WAIT backoff; atomic finalized message writes; heartbeat + cursor
- Operator chat bot is separate from router fanout bot
- Chat replies allowlist-checked before any handling (INV-B3)
- Market fanout Telegram text is a fail-closed **topic deep-dive**
  (`broadcast.telegram_overview` key preserved; one subject per message, ≤3,400
  Markdown chars). The daily **narrative map** is a separate host-only
  `narrative.digest` at 20:00 Europe/London (`broadcast.telegram_digest.enabled`)
  covering every active narrative in one message (same hard cap). Discord stays a
  run-scoped **own** bottom-line distill (at most one Discord payload per run —
  never a reuse of the TG topic text)
- Fanout + operator sends convert markdown → HTML, deslug kebab narrative
  labels (`rh-chain-meme-rotation` → `RH Chain Meme Rotation`), and scrub leaked
  hour tokens (`72h` → `the next few days`) — natural watch prose (`this week`,
  `this month`) is left alone. Distill injects host-derived `watchWindow` from
  claim type + `horizonHours` (audit settlement stays 24/72/168) — ADR 013
- See [ADR 013](../adr/013-watch-window-decoupled.md) for the watchWindow vs
  horizonHours split

## Alpha ingestion vs operator chat

| Surface | Process | Config / env |
|---------|---------|--------------|
| Alpha channels | `tc listen channels` / `com.trenchcoat.channels` | `telegram_channels[]` |
| Operator DMs | `tc listen telegram` / `com.trenchcoat.listener` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OPERATOR_ID` |
| Broadcast fanout | `tc router serve` / `com.trenchcoat.router` | `TELEGRAM_ROUTER_*` |

Working alpha: `mode: "preview"`, poller logs `preview:N` / `telegram preview polled`
(on a ~60s cycle per channel batch), queue files under `agent/alpha-queue/<channel>/` with `provenance: telegram:<channel>`.
Each newly written message enqueues an immediate `telegram-alpha` agent pass
(serial pump, ≤8 paths/run under the workspace lock; exit 3 retries). Collect
seals each cited alpha-queue message body into
`inbox/<run-id>/telegram-alpha-<channel>-<id>.json` and writes a manifest with
`path=… contentHash=sha256:…`. After the agent, the host enqueues research from
sealed CAs or cashtags+chain hints ([ADR 015](../adr/015-telegram-alpha-research.md),
≤3/run) and drains the research queue. The agent must still emit
`alpha-digest.json` with `entries[]` for every cited message — real research note
**or** `state/research/alpha-ack-<channel>-<id>.md` tombstone — so INV-Q1 can
purge (host research alone does not clear the queue). Prefer empty telegram-alpha
outbox — research proposes market broadcasts when the dossier is solid; those go
through worthiness ([ADR 014](../adr/014-broadcast-worthiness.md)) then Discord
webhook budget/run-dedupe. Telegram remains uncapped by daily count after approval.
`list-scan` / `review` may still write path-only alpha manifests for backlog
drain; primary live digestion is `telegram-alpha`.
List-scan writes `list-scan-alpha-manifest`; review writes `review-alpha-manifest`.
Both are path-only and capped at 500 items (`truncated=N` when the queue is
deeper) so digest can still run while backlog is drained. Overflow keeps the
first 499 paths in channel/file sort order and drops the rest until later runs
digest + purge (INV-Q1) shrink the queue — never mass-delete undigested files
to “fix” the cap. Mid-day 2026-07-19 list-scans aborted with Zod `too_big`
before the cap shipped; current runtimes must always call `capManifestLines`
before `SnapshotWriter.writeInbox`. List-scan collection status / chat notes
surface `alphaPending` and `alphaTruncated` when the queue is non-empty or
capped. Digests must use `entries[]` with message/record `contentHash` values
(byte hashes of on-disk files) — narrative-shaped `items`/`slug` digests fail
Zod and purge **nothing** (`invalidReason=schema-invalid` on the receipt; chat
notes `alphaDigestInvalid` / `alphaPurged`). Sync skills with
`./ops/install-launchd.sh --sync-skills` (or alongside a full install).
Operator chat working (`operator:telegram:…` research) does **not** imply alpha
ingestion is live — check channels poller logs and `alpha-queue/` separately.

## Troubleshooting

- **Idle poller / no queue growth** — allowlist is all `gramjs` and session missing.
  Logs: `preview:0` + `skipping gramjs until auth`. Fix: set channels to
  `mode: "preview"`, restart **channels** (not listener).
- **Only `@telegram` product blog in queue** — config (or stale cursor) used the
  handle `telegram`. Remove that entry; purge `alpha-queue/telegram/` and the
  `telegram` cursor key; use real alpha handles.
- **Seed defaults** — `config/seed.example.json` is preview-first for all listed
  public call channels.
- **Queue deep / digests never purge** — agent wrote narrative `items` instead of
  `entries` + content hashes, or skipped digest after ADR 015 research. Receipt
  shows `invalidReason=schema-invalid` and chat `alphaDigestInvalid` /
  `alphaPurged=0`. Fix skills (telegram-alpha requires knowledge **or** ack
  tombstone), `./ops/install-launchd.sh --sync-skills`, redeploy host; do not
  mass-delete the queue. Last-resort operator drain:
  `pnpm exec tsx scripts/alpha-queue-drain.ts` (writes minimal archive record +
  host-valid digest; see orchestrator.md § Alpha-queue).
- **Skill / collector edits** — `ops/install-launchd.sh` redeploys the CLI runtime;
  pass `--sync-skills` to rsync `agent/skills/**` + `AGENTS.md` into
  `~/.trenchcoat/agent/` (and discord agent when present).
- **Poll interval change** — default cycle is code in `channels.ts`, not config;
  after redeploy restart **`com.trenchcoat.channels`** and confirm startup log
  `pollMs` (2026-07-20 live: `60000` = 60s; was `1800000`).
- **Immediate agent not firing** — channels must be the redeployed runtime with
  `onNewMessage` → `createTelegramAlphaPump`; check `/tmp/trenchcoat.channels.*.log`
  for `telegram-alpha pass` lines and lock contention (`busy — will retry`).
