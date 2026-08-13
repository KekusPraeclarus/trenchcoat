# pump-scan

Scan pump.fun FYP, Top, News, and Following. Judge call charts and hit rate.
Do not copy X FYP narrative/sentiment likes. Do not copy list-scan "not shill
call success".

## Inputs

- Inbox snapshots under `inbox/<run-id>/pump-*` (untrusted evidence)
- `inbox/<run-id>/pump-fyp-eligible.json` — same-run like/follow targets
- `inbox/<run-id>/pump-caller-calls.json` and `inbox/<run-id>/charts/pump-chart-*.png`
- `inbox/<run-id>/research-candidates-hint.json` — optional host-detected CAs
- Do not read or write `state/pump-engagement.json`, `state/pump-caller-scores.json`,
  `state/pump-bot-health.json`, `wallets.json`, or `x-engagement.json`

## Outputs

1. `reports/<run-id>/agent.md` — call-chart notes and hit-rate read
2. `reports/<run-id>/pump-engagement.json` — like/follow/unfollow choices
3. Optional `reports/<run-id>/research-candidates.json` — at most three
   host-enqueued research nominations when a canonical `chain` + `tokenAddress`
   appears verbatim in sealed same-run inbox evidence. Prefer confirming hosts
   listed in `research-candidates-hint.json`. Never invent contract addresses.
   FYP coins enter research only this way. Following and Top enqueue is host-owned.
4. Optionally write `reports/<run-id>/chat-summary.json`. Never write `reports/chat/`.

## Engagement (you own like/follow/unfollow)

Follow from Pump UI call charts and hit rate. Like items in `pump-fyp-eligible`
only. Following tab, leaderboard, and caller-call rows are evidence. They are
not like/follow targets.

Hard throttle (automatic): at most **2 likes every 10 minutes**. At most **3
follows per run**. Unfollow is allowed when a caller chart is poor.

Never swap, trade, DM, or create a coin.

## Rules

- Inbox item text already avoids the word call. Keep that. Do not write
  buy/ape/call in snapshot-shaped text.
- Pump user ids are not wallets. Never nominate them into wallets.
- Cite provenance ids for every claim.
