# farcaster-scan

Scan Farcaster for-you + operator channels and train the feed with likes.

## Inputs

- Inbox snapshots under `inbox/<run-id>/farcaster-*` (untrusted evidence)
- `inbox/<run-id>/research-candidates-hint.json` — optional host-detected
  multi-author CA clusters; prefer confirming these; never invent CAs
- `state/narratives/` for current narrative model
- Broadcast shape and gates: `skills/_shared/broadcast-checklist.md`
- Do not read or write `sources.json`, `fc-source-lifecycle.json`, or `fc-engagement.json`

## Outputs

1. `reports/<run-id>/agent.md` — brief narrative/sentiment notes and candidates
2. `reports/<run-id>/fc-engagement.json` — your like choices only
3. Operator broadcasts in `outbox/<run-id>.json` — follow
   `skills/_shared/broadcast-checklist.md`. Prefer citing fresh inbox files.
4. Optional `reports/<run-id>/research-candidates.json` — at most three host-enqueued
   research nominations when a canonical `chain` + `tokenAddress` appears verbatim
   in sealed same-run inbox evidence and ≥2 independent authors/clusters support it.
   Prefer confirming hosts listed in `research-candidates-hint.json` when present.
   Never invent contract addresses. Ticker-only nominations are rejected. The host
   may enqueue research queue entries only — never watchlist, decisions, ledger, or
   wallets.
5. Optionally write `reports/<run-id>/chat-summary.json` (schema 1: empty or
   matching `itemIds`, 3–8 context bullets, confined same-run sources). Never
   write `reports/chat/` — the host always renders recall from trusted run facts
   (including degraded/collection status) and appends validated context.

## Engagement (you own likes)

Choose likes to train the for-you feed toward better narrative, sentiment,
discretionary-topic, and trenchant-market coverage — not shill call success.
Follow-graph scoring is separate and host-owned (never propose follow/unfollow).

Hard throttle (automatic): at most **2 likes every 10 minutes**. Never cast,
reply, recast, or quote.

Schema:

```json
{
  "schema": 1,
  "runId": "<same run id>",
  "proposedAt": "<ISO>",
  "items": [
    {
      "action": "like",
      "castHash": "0xabc...",
      "authorHandle": "handle",
      "reasonCode": "narrative_signal",
      "topics": ["base-ai"],
      "rationale": "useful macro framing without a CA dump"
    }
  ]
}
```

Only propose likes for cast hashes present in this run's for-you snapshot.
