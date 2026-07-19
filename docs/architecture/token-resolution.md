---
description: Canonical candidate identity - resolving tickers/CAs from untrusted text to one (chain, token_address, pair_address) triple before anything is counted, researched, or tracked. Deterministic-first with bounded model-judged disambiguation for ambiguous tickers.
scope: module
status: draft
last_verified: 2026-07-19
read_when:
  - Editing src/lib/resolve.ts, mention counting, the research queue, or watchlist entry creation.
---

# Token resolution

## Purpose

Social text names tokens ambiguously: a ticker can collide across dozens of
unrelated contracts, and a contract address can trade in several pools. If we
research, count mentions for, or price outcomes against the wrong asset, every
downstream number (divergence, source scores, paper P&L) is silently wrong.
Resolution runs **before** a candidate can be tracked anywhere in the system:
deterministic host code (`src/lib/resolve.ts`) first. Ambiguous tickers stay
`ambiguous` until an operator Telegram shortlist pick (shipped) or a later
raw-CA context binds them. A bounded model-judged disambiguation session is
designed below (INV-S16) but **not yet wired** — `DISAMBIGUATION_PROMPT` and
`validateModelPick` exist; no cron resolver session launches them.

## Canonical identity

Every candidate, watchlist entry, ledger position, and attribution match keys on:

```json
{
  "chain": "solana",
  "token_address": "…",
  "pair_address": "…",
  "symbol_display": "TICKER",
  "resolution": "resolved | model-confirmed | ambiguous | unsupported-chain",
  "resolution_confidence": 90,
  "resolution_note": "one line, only for model-confirmed"
}
```

`chain` must exist in the chain registry (chains.md). `symbol_display` is
cosmetic only — no logic ever keys on ticker.

## Resolution order

1. **Contract address in the raw text** (best case, common in alpha channels) —
   validate format per chain family, then confirm existence via DexScreener
   token lookup. CA-first is why attribution string-matching works
   (orchestrator.md, INV-S12). `resolution: "resolved"`.
2. **Ticker/name, deterministic** — DexScreener search across registry-supported
   chains, collapsed to one candidate per `(chain, token_address)` (deepest pool),
   filtered to exact symbol matches when the query is a ticker, then ranked by
   credibility (active markets: `liquidityUsd + 0.35 * volume24hUsd`; idle
   dust-volume pools are heavily demoted so high-liq clones lose to live
   markets). Synthetic DexScreener pair ids (`:bpool`, non-20-byte hex) are
   dropped before ranking. For exact-ticker queries, every candidate retaining
   at least 5% of the top credibility score stays in the operator shortlist;
   market prominence ranks choices but never proves identity. A sole credible
   candidate resolves automatically. `resolution: "resolved"`.
   No chain is preferred a priori — ethereum is not a default. Operator text may
   constrain the search with an explicit chain hint (`research $REPPO on base` /
   `chainHint: "base"`).
   Narrative bridge inputs use the same path: explicit `tickers` in a narrative
   log entry plus bounded `$TICKER`, ALLCAPS, and CamelCase extraction. A
   narrative ticker only produces a research-queue record, never a watchlist
   entry.
3. **Ticker/name, operator pick (shipped) / model-judged (designed)** — when no
   candidate dominates, operator Telegram research DMs a numbered shortlist that
   always includes the chain (`1. base:0x…`) and waits for a pick before
   continuing (`src/chat/pending-research.ts`). Cron model-judged dossier
   sessions (below) are not launched yet — ambiguous cron subjects stay
   `ambiguous`. `resolution: "model-confirmed"` on a validated pick,
   `ambiguous` otherwise.
4. **Pool selection** — for the resolved token, the canonical pair is the
   highest-liquidity pool on the token's primary chain. Pool migrations
   (liquidity moving to a new pair) are detected on the watchlist-scan cycle
   and update `pair_address` with a dated note in the token's research file.

## Model-judged disambiguation (designed — not wired)

**Status (2026-07-18):** interface/schema/`validateModelPick` exist; no
`writeResolution` archive writer and no cron session consume
`DISAMBIGUATION_PROMPT`. Treat this section as the target design until a
session + `archive/resolution-log.jsonl` land.

Ambiguity is not a hard stop — a shill usually contains enough context to
identify the exact token, and the model is better at that judgment than any
threshold. The mechanics keep the judgment bounded:

- The resolver writes a **dossier** into the run's snapshot: the quoted
  mention(s) with timestamps, and for each shortlist candidate (top DexScreener
  matches on supported chains) its full canonical identity, market cap,
  liquidity, pool age, txn activity, and precomputed chart summary —
  **RSI at mention time** on 1h and 4h (current, previous, delta, bar cutoff,
  validity, and input hash), volume z-score, and the move over the window
  leading into the mention. The chart block matters twice: the agent uses it
  to test the message's claims now, and the audit uses it to learn which
  signatures predict the right pick later (see Disambiguation audit trail)
- Every `_at_mention` feature is recomputed over candles truncated to
  `mention_ts`: only a candle whose interval ended on or before the mention may
  enter. Fetch/disambiguation time is recorded separately and can never select a
  later candle. If history, activity, or continuity requirements fail, the
  feature is explicitly invalid
- The agent session weighs the message against each candidate's reality and
  **confirms only on high confidence** that message and token are consistent.
  There are no hard numeric constraints — the canonical rejections are
  judgment calls: a $2k-MC token can't be the subject of "everyone's already
  in", $800 liquidity contradicts "whales loading", a claimed "3x today"
  must actually be on the candidate's chart. Mismatch on any load-bearing
  claim, or no candidate standing out → stays `ambiguous`, with the doubt
  noted in the report
- **Shortlist-only**: the confirmation is a pick from the dossier's
  candidates, recorded with confidence and one-line reasoning. The orchestrator
  validates the pick against the dossier before binding it — the model can
  never introduce an address that wasn't in deterministic collector output
  (INV-S16)
- The judgment runs as a fresh one-shot resolver session with no tools or
  workspace access. Host code supplies one dossier, strictly parses
  `picked_candidate_id | abstain`, validates the id against the shortlist, and
  discards all other output. Daily invocation caps and dossier/result caching
  prevent ambiguous-ticker floods from becoming an unbounded model-cost path;
  deferred records remain `ambiguous`
- A confirmed binding is written to the queue entry / research file by the
  orchestrator and is then a normal canonical identity: gate, market-quality,
  and research all run against it before any `track` (INV-S9 unchanged)

`ambiguous` candidates also still resolve the boring ways: a later item from a
**different source cluster** supplies the CA, or the operator supplies it via
chat/CLI.

## Disambiguation audit trail (designed — not wired)

Rejecting a ticker-only call is itself a call, and it must be gradeable. When
the model-judged path lands, every disambiguation — confirm *or* abstain —
will be logged by the orchestrator to the host-side resolution log
(`~/.trenchcoat/archive/resolution-log.jsonl`, snapshot-archive.md), one
record per verdict. `ResolutionReceiptSchema` exists; no writer yet:

```json
{
  "id": "res-2026-07-16-004",
  "mention_ts": "2026-07-16T09:40:00Z",
  "provenance": ["telegram:channelname"],
  "symbol": "TICKER",
  "shortlist": [
    { "chain": "…", "token_address": "…", "pair_address": "…",
      "mc_usd": 240000, "liquidity_usd": 61000,
      "rsi_1h_at_mention": { "value": 58.3, "previous": 54.9,
        "delta": 3.4, "last_closed_bar_ts": "2026-07-16T09:00:00Z",
        "valid": true, "input_hash": "sha256:…" },
      "rsi_4h_at_mention": { "value": 51.7, "previous": 49.2,
        "delta": 2.5, "last_closed_bar_ts": "2026-07-16T08:00:00Z",
        "valid": true, "input_hash": "sha256:…" },
      "vol_z_at_mention": 1.9,
      "move_24h_into_mention": 0.12 }
  ],
  "verdict": "confirmed | abstained",
  "picked": "token_address | null",
  "confidence": 85,
  "reasoning": "one line"
}
```

The weekly audit closes the loop deterministically (metrics in
audit-metrics.md): it prices **every shortlist candidate** from `mention_ts`.
A later raw CA from the same source context is ground truth. When none arrives,
post-mention excess move and volume separation may produce a proxy label, but
ground-truth and proxy cohorts are never merged. Each record grades as
pick-correct, pick-wrong, abstain-missed, abstain-right, or undetermined, with
the label class persisted.

**RSI as the determinism upgrade path**: because every record carries each
candidate's versioned RSI/volume signature *at mention time*, the audit can test
pre-registered shadow tie-breakers. Price-derived proxy labels are exploratory
only: using a subsequent move both to choose the "correct" token and validate a
momentum feature would be circular.

A tie-breaker can graduate into resolver step 2 only on later-CA ground truth,
after a forward-only holdout and the minimum sample/confidence-bound gate in
audit-metrics.md. Promotion is a reviewed developer change in
`src/lib/resolve.ts`, config, and this doc, never an automatic audit write. The
promoted rule remains shadow-monitored, and invalid/missing indicator inputs
fall through to model judgment rather than forcing a pick.

## What model confirmation can never do

A `model-confirmed` identity drives research eligibility and mention counting —
nothing with security consequences:

- **Rug-dock attribution stays raw-CA-only** (INV-S12): sources are docked
  when their *raw text* contained the rugged token's address. A model's guess
  about which token a vague shill meant can neither dock a source nor exonerate
  one — otherwise an injected message could frame a rival by steering the
  disambiguation
- It cannot bypass the security gate, the market-quality preflight, or the
  chain registry's fail-closed rule
- Resolution alone never writes `watchlist.json`; only a research dossier,
  security gate, and host-validated decision proposal may create tracking state

## Mention counting

Divergence maths uses `resolved` and `model-confirmed` identities. Ticker
mentions with no binding at all are excluded — hype with no identifiable
subject is noise by policy. Once a binding exists for a candidate, subsequent
same-ticker mentions in the same context window count toward it.

## Consequences elsewhere

- Twitter collectors search by CA when known, ticker only as fallback discovery
- `watchlist.json` carries `token_address` and `pair_address` (schema in
  agent-workspace.md)
- Attribution (rug-dock and audit) matches on `token_address` **and**
  `pair_address` strings in raw items — never on ticker
- Audit prices outcomes against the canonical `pair_address` recorded at
  decision time, even if the pool later migrated (the migration is a note, not
  a rewrite)

## Audit metrics

- CA mismatch rate: decisions whose cited evidence resolves to a different
  `token_address` than the one priced at audit time. Target: zero; any hit is
  a resolver bug, flagged in the audit report.
- **Disambiguation precision/recall** (from the resolution log, formulas in
  audit-metrics.md), split by ground-truth vs proxy labels: pick-correct rate
  among confirms, abstain-missed rate among abstains, and RSI shadow-rule
  performance. Proxy association can generate a hypothesis but never promote
  one.
