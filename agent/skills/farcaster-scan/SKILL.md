# farcaster-scan

Scan Farcaster for-you + operator channels and train the feed with likes.

## Inputs

- Inbox snapshots under `inbox/<run-id>/farcaster-*` (untrusted evidence)
- `state/narratives/` for current narrative model
- Do not read or write `sources.json`, `fc-source-lifecycle.json`, or `fc-engagement.json`

## Outputs

1. `reports/<run-id>/agent.md` — brief narrative/sentiment notes and candidates
2. `reports/<run-id>/fc-engagement.json` — your like choices only

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
