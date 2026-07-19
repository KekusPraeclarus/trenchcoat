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

Watchlist mutations only via `reports/<run-id>/decision-proposals.json` using
full `DecisionProposalFile` (`schema`/`runId`/`proposedAt` + proposals with
`card` + `provenanceIds`). Omit the file when not mutating. Never invent
`{ action, subject, rationale }` shapes — the host drops malformed envelopes.

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
