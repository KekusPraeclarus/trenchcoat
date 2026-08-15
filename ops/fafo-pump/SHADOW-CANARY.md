# Pump.fun rollout — shadow to canary

Operator playbook for the pump.fun feed scan lane (ADR 047). Code lives in
this repo. Production runs on the Linux VPS only. Mac launchd stays unloaded
while the VPS is production.

**Status (2026-08-13):** shadow live on VPS — `pump.enabled=true`,
`pump.shadow_mode=true`, burner session synced, smoke pass, provider gate
`pass` from `gates.shadow-live.json`. Full FAFO discover and 14-day shadow
graduation are still open.

Related: [REPORT.md](REPORT.md) (API shapes), [docs/knowledge/pump-fun.md](../../docs/knowledge/pump-fun.md),
[ADR 047](../../docs/adr/047-pump-feed-scan.md).

## Capability matrix

| Capability | Off (`enabled=false`) | Shadow (`shadow_mode=true`) | Canary (`shadow_mode=false`) |
|---|---|---|---|
| `pump-scan` job | Skipped | Runs every 30m | Runs every 30m |
| FYP / Top / News / leaderboard scrape | — | Yes | Yes |
| Agent `pump-engagement.json` proposals | — | Yes | Yes |
| Likes / follows on pump.fun | — | No | Yes (caps below) |
| Research enqueue (Following → Top) | — | No | Yes (3/day cap) |
| `pump-call` archive + settle | — | Yes | Yes |
| Following tab scrape | — | Only after 10 follows in state | Same |
| Wallet nomination | — | Never | Never |

Shadow collects and archives. It does not mutate research queue, watchlist,
`wallets.json`, or X engagement.

## One-time VPS bootstrap

Do this once per host. Do not paste cookies, import files, or session values
into chat or git.

### 1. Deploy code

Push `main`, then on the VPS:

```bash
~/bin/trenchcoat-deploy
```

Confirm `trenchcoat status` shows `configSchema=27`, `runtime=27`, and
`pump: enabled=… shadow=…`.

### 2. Copy burner session

On the **Mac** (after local smoke passes):

```bash
ssh "$TRENCHCOAT_SSH_HOST" 'mkdir -p ~/.trenchcoat/pump-profile && chmod 700 ~/.trenchcoat/pump-profile'
rsync -a ~/.trenchcoat/pump-profile/storage-state.json \
  "$TRENCHCOAT_SSH_HOST:~/.trenchcoat/"pump-profile/
ssh "$TRENCHCOAT_SSH_HOST" 'chmod 600 ~/.trenchcoat/pump-profile/storage-state.json'
```

Copy `storage-state.json` only. Do not rsync import files or Chrome profile
dirs. Re-import on the Mac with `pnpm dev:cli auth pump --import-*` when the
session expires, then repeat the rsync.

### 3. Enable shadow config

On the VPS:

```bash
cd ~/src/trenchcoat
trenchcoat config migrate --write
```

Set in `~/.trenchcoat/config.json`:

```json
"pump": {
  "enabled": true,
  "shadow_mode": true,
  "engagement": { "enabled": true },
  "leaderboard": { "enabled": true }
}
```

`chmod 600 ~/.trenchcoat/config.json`.

### 4. Install gates

Fail-closed seed (blocks collection):

```bash
pnpm pump:install-gates ops/fafo-pump/gates.seed.json
```

Shadow go-live minimum (provider pass from Mac smoke — replace after FAFO):

```bash
pnpm pump:install-gates ops/fafo-pump/gates.shadow-live.json
```

Gates file: `~/.trenchcoat/archive/provider-evaluations/pump/gates.json`.
Must be fresh (≤30 days) with `provider.verdict: "pass"`.

### 5. Smoke on the VPS

```bash
TRENCHCOAT_LIVE_PUMP=1 pnpm pump:smoke
```

Want non-zero `fyp`, `top`, `news`, and `leaderboard`, plus `error: null`.

From the Mac:

```bash
./ops/remote.sh -- 'cd ~/src/trenchcoat && TRENCHCOAT_LIVE_PUMP=1 pnpm pump:smoke'
```

## Phase 1 — Prove shadow (first few days)

Checklist after enable:

- [ ] `systemctl --user is-active trenchcoat-job-pump-scan.timer` → `active`
- [ ] At least one completed `pump-scan-*` run under `~/.trenchcoat/agent/inbox/`
- [ ] Snapshots present: `pump-fyp`, `pump-top`, `pump-news`, `pump-leaderboard`,
      `pump-fyp-eligible`
- [ ] Archive outcomes: `~/.trenchcoat/archive/outcomes/pump-call-pump-scan-*.json`
      when caller profiles return data
- [ ] `trenchcoat status` shows no pump skip reasons (`pump-disabled`,
      `pump-provider-gate`, `pump-missing-session`, `pump-upstream`)

Verify from the Mac:

```bash
./ops/remote.sh status | grep pump
./ops/remote.sh -- 'ls -d ~/.trenchcoat/agent/inbox/pump-scan-* 2>/dev/null | tail -3'
```

Optional operator broadcast (fanout via router — not a narrative update):

```text
! 🤖 BOT UPDATE 🤖 !

Pump.fun feed scan is now live on the host in shadow mode. It collects FYP,
Top, News, and leaderboard handles for training. Likes, follows, and research
enqueue stay off for now.

Expect a few rough runs while this settles. Market narrative broadcasts are
unchanged.
```

Stage through the normal router path when ready. Do not paste session material.

### FAFO discover (replace thin gates)

Run on the VPS with a live session:

```bash
TRENCHCOAT_LIVE_PUMP=1 pnpm probe:pump discover --run-id probe-YYYY-MM-DD
pnpm probe:pump sanitize --run-id probe-YYYY-MM-DD
pnpm probe:pump status --run-id probe-YYYY-MM-DD
```

When sample size is enough, write a gates file with real metrics and install:

```bash
pnpm pump:install-gates ops/fafo-pump/gates.<evaluated>.json
```

Update [REPORT.md](REPORT.md) with any new POST paths. Do not treat GitHub API
dumps as pump.fun truth.

## Phase 2 — Shadow graduation (14 UTC days)

Keep shadow config unchanged for **exactly 14 UTC days** after the first clean
`pump-scan` run.

Graduate only when all are true:

- Provider success ≥ 95% over the window (review job receipts / skip reasons)
- No secret leak or invariant breach (INV-I3, INV-S19, INV-S30)
- Operator reviewed snapshot quality and skip rates
- Gates backed by FAFO sample, not `gates.shadow-live.json` alone

During shadow, confirm these stay unchanged across runs unless another lane
writes them:

- `agent/state/wallets.json`
- `agent/state/research-queue.json`
- `agent/state/watchlist.json`
- X engagement state

## Phase 3 — Canary

Flip one field on the VPS:

```json
"pump": {
  "enabled": true,
  "shadow_mode": false,
  "engagement": { "enabled": true },
  "leaderboard": { "enabled": true }
}
```

Do **not** raise caps for the first canary week:

| Cap | Value |
|---|---|
| Likes | 2 per 10 minutes |
| Follows | 3 per `pump-scan` run |
| Research enqueue | 3 per UTC day (Following first, then Top) |

Canary turns on:

- Host apply of agent like/follow/unfollow (separate mutation Playwright session)
- Research enqueue from Following, then Top
- FYP coins still enter research only via agent `research-candidates.json` with
  a verbatim CA

Watch the first canary runs for engagement receipts, research queue growth, and
session errors.

## Phase 4 — Following tab

The host skips Following until `state/pump-engagement.json`
`followedHandles.length` ≥ `following_min_follows` (default 10).

Below the floor the run writes `following-skipped-below-min` in
`pump-scan-collection-status`. This is expected early in canary.

## Ongoing

| Task | Cadence |
|---|---|
| Live smoke | Monthly: `TRENCHCOAT_LIVE_PUMP=1 pnpm pump:smoke` on VPS |
| Session refresh | When smoke or scans report `unauthorized` / `challenged` |
| Gate refresh | After FAFO re-run or API shape change |
| `outcomes-settle` | Existing 6h job settles `pump-call-*` at 24h peak |

Session re-import flow: [docs/knowledge/pump-fun.md](../../docs/knowledge/pump-fun.md)
§ Session import.

## Skip reasons (quick reference)

| Reason | Fix |
|---|---|
| `pump-disabled` | Set `pump.enabled=true` |
| `pump-provider-gate` | Install fresh gates with `provider: pass` |
| `pump-missing-session` | Rsync `storage-state.json` or re-import |
| `pump-upstream` / `challenged` | Re-auth burner; check request policy |
| `pump-budget_exhausted` | Wait for UTC day rollover or raise budget in config |

## Mac vs VPS

| | Mac | VPS |
|---|---|---|
| `pump-scan` timer | Unloaded in production | Active |
| Session | Local dev / import source | `~/.trenchcoat/pump-profile/` on VPS |
| Code edits | This repo | `~/bin/trenchcoat-deploy` after push |

Use `./ops/remote.sh health` and `./ops/remote.sh status` from the Mac for live
checks. Do not SSH to browse `src/` — read code here.
