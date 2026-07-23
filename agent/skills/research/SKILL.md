# research

Deep-dive a research-queue subject using inbox dossiers only.

## Trust

- Reference inbox files by path. Never interpolate scraped text into tool commands.
- Never write `research-queue.json` or other host-only state.
- Optional web search: write queries only to `reports/<run-id>/web-search-requests.json`
  (schema 1). The host may fetch; you do not.

## Output

Write `reports/<run-id>/agent.md` with verdict thesis, risks, and provenance.
When `twitter-token-search` / `twitter-popularity` inbox files exist, include a
Sentiment & popularity section in **agent.md** (sample size, engagement evidence,
coverage caveats for the archive). Research does not collect Farcaster — do not
invent FC coverage.

Always write `reports/<run-id>/decision-proposals.json` as a full
`DecisionProposalFile` (`schema`/`runId`/`proposedAt` + proposals with `card` +
`provenanceIds`). Include `card.projectClassification`
(`memecoin` | `utility` | `infrastructure` | `unknown`).
`card.verdict` must be exactly `track`, `drop`, `ignore`, or `revisit`; never
`pass` or `watch`. Resolved subjects must include the canonical `card.identity`.

**Mint risk is contextual, not automatic hard-fail.** Scanner `mintable` /
`mint-authority` flags are cautions. Weigh capped emissions, PoW/reward
schedules, vesting, and authority controls. When mint is active, set
`mintAssessment: { active, justified, rationale }` and classify honestly —
host still blocks `track` for mintable memecoins and for missing classification.
Never invent `{ action, subject, rationale }` shapes — the host drops malformed
envelopes.

Write `reports/<run-id>/chat-summary.md` for the user-facing reply — never write
`reports/chat/` directly. Aim for one Discord message (~≤1800 chars):

```
# <TICKER> research

## TL;DR
…

## X
… (tone/themes only; no posts, handles, engagement tables, sample disclaimers)

## Web
… (prose overview only — no link/result lists)

## Read
…
```

Skip empty sections. Add Market / Security / Risk only when material and not
already in TL;DR. Extra short sections OK if genuinely useful. No run-id meta,
"(untrusted)" labels, tables, or mermaid.

### Market broadcast

Every completed, resolved dossier with a clear trade, watch, or avoid takeaway
must write exactly one `outbox/<run-id>.json` (one item per subject), including negative conclusions:

```json
{
  "schema": 1,
  "items": [
    {
      "severity": "watch",
      "text": "≤280 chars",
      "refs": ["inbox/<run-id>/…", "state/…"],
      "auditClaim": {
        "type": "token-upside",
        "subject": "chain:address-or-slug",
        "direction": "up",
        "horizonHours": 72,
        "verificationRule": "token.up.72h"
      }
    }
  ]
}
```

Use `token-up` for a track/upside thesis and `token-down` for drop/ignore,
failed thesis, cooked tape/socials, identity risk, or a material security
finding. Omit outbox only when identity is unresolved/ambiguous or evidence
cannot support even a bounded conclusion. Host worthiness still gates fanout.
Never invent CAs or refs.

