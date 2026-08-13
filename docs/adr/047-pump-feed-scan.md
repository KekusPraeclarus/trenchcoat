---
description: ADR — pump.fun web SPA feed scan, agent like/follow, host call archive and peak settle, host research enqueue.
scope: project
status: accepted
last_verified: 2026-08-13
read_when:
  - Editing src/collectors/pump/, pump-scan, pump engagement, or pump-call settle.
  - Changing pump.fun auth, request policy, or feed curation rules.
---

# ADR 047 — Pump.fun feed scan and call backtest

## Context

Traders use the pump.fun app to check holders and find coins. The public
[pump.fun](https://pump.fun) SPA already has Feed (For you / Top / News /
Following), Leaderboard, and user search. An emulator is not the path.

X FYP likes train narrative/sentiment. Pump follows must judge call charts
and hit rate. Fomo stays as a parallel lane.

## Decision

1. **Web SPA only.** Host Playwright against pump.fun with a burner session
   at `~/.trenchcoat/pump-profile/`. No emulator. No unofficial API dumps as
   source of truth. Request policy is fail-closed until FAFO capture fills it.
2. **Agent owns like/follow/unfollow** for same-run FYP/Top/News items in
   `pump-fyp-eligible`. Caps: 2 likes / 10 minutes, 3 follows per run.
   Following, Leaderboard, and profile calls are evidence only.
3. **Host owns call archive and settle.** Structured Pump UI calls go to
   `archive/outcomes/pump-call-*.json`. They never enter
   `source-call-log.jsonl` or X `source-lifecycle.json`. Settle waits 24h,
   then ADR 032 quiet 6h / force 14d / hit +20%. Security-gate `hardFail`
   after the call is `terminal-loss` and stops rechecks.
4. **Host owns research enqueue** from Following first, then Top, when
   `shadow_mode=false`. FYP coins enter research only via agent
   `research-candidates.json` with a verbatim CA.
5. **No wallets from profiles.** Pump user ids never enter `wallets.json`.
6. **Two Playwright sessions.** Read-only scrape, then a later mutation
   session. Collectors never like during scrape.
7. **Following tab** only when `followedHandles.length >= 10`.
8. **Defaults off.** `pump.enabled=false`, `shadow_mode=true` until gates pass.

## Consequences

- New job `pump-scan`, state `pump-engagement.json` and
  `pump-caller-scores.json`, config schema 27.
- Health reports Pump as a parallel-only section. Not in KEY_HEALTH_JOBS yet.
- Fomo and X engagement lanes stay unchanged.

## Alternatives considered

- **Android/iOS emulator** — rejected. Fragile, ToS risk, TLS pinning.
- **Reuse X FYP engagement** — rejected. INV-S22 binds likes to
  `x-fyp-eligible` only. Pump item ids are not tweet ids.
- **Farcaster host-owned follow graph** — rejected. The operator wants the
  agent to follow from Pump UI call charts.
- **KeepAlive listen loop** — rejected. Playwright lock contention with Fomo
  and X. Interval 30m.

## Follow-ups

- Live `pnpm probe:pump discover` fills request-policy POST allowlists.
- Shadow 14 UTC days, then canary `shadow_mode=false`.
- outcomes-settle runs pump-call settle after Fomo copy-trade (does not
  rewrite ADR 032).
