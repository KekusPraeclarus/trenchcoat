---
description: Host-side snapshot archive and decision-time as-of bundles - the immutable record that source attribution and audits read from, and the leakage firewall that makes calibration valid.
scope: module
status: draft
last_verified: 2026-07-16
read_when:
  - Editing the run loop's archiving, source attribution inputs, audit outcome computation, or retention.
---

# Snapshot archive and as-of bundles

## Purpose

Two problems, one mechanism:

1. **Tamper-evidence** — source attribution (INV-S12) must read collector
   output the agent could never have touched, so scores can't be gamed by
   anything written inside the workspace.
2. **Leakage** — audits are only valid if every outcome is computed against
   what was knowable *at decision time*. If the audit can see post-decision
   data while grading a decision, calibration and counterfactuals are fiction.

## Archive layout

Outside the repo and outside `agent/`, owned by the orchestrator:

```
~/.trenchcoat/archive/
├── runs/<run-id>/
│   ├── inbox/           # byte-identical copy of agent/inbox/<run-id>/,
│   │                    #   written BEFORE the agent session starts
│   ├── sources-start.json # byte-identical source scores used by this run
│   ├── config.json       # redacted non-secret config + schema/hash
│   ├── alpha-digest.json  # copied after the run (what the agent claimed digested)
│   ├── report.md          # the run's briefing
│   └── manifest.json      # run id, job, timestamps, file sha256 list
├── decisions/<decision-id>.json   # as-of bundles (below)
├── outcomes/<subject-type>/<subject-id>/<horizon>.json # immutable observations
├── epochs/<epoch-id>/
│   ├── manifest.json      # cutoff, versions, cohort ids, input/output hashes
│   └── status.json        # building | sealed
├── transactions/<run-id>.json # fsynced run phase journal + idempotency hashes
├── telemetry/runs/<run-id>.json # tokens by session kind + API/cache counters
├── market/blobs/<sha256>.json.gz  # canonical, content-addressed OHLCV payloads
├── resolution-log.jsonl   # every ticker-only disambiguation verdict incl.
│                          #   abstains, with the full candidate dossier
│                          #   (token-resolution.md) — graded weekly
├── source-call-log.jsonl  # deterministic bullish call events from raw items
└── discovery-log.jsonl    # candidates rejected/expired before research
                           #   (research-queue.md) — counterfactual pricing
```

- The pre-session copy is the **only** input to attribution string-matching —
  never the workspace copy (INV-S12)
- `manifest.json` hashes make tampering detectable; the integrity check
  re-verifies hashes before any attribution or audit read
- Market payloads are canonicalised, compressed, and keyed by SHA-256. Run,
  decision, resolution, and outcome records reference the hash instead of copying
  identical candle arrays. A hash mismatch is corruption, never a cache miss
- Archive writes use a same-filesystem temporary file, fsync, and atomic rename.
  Existing content-addressed blobs and sealed epoch records are immutable;
  conflicting bytes under an existing logical id halt the audit
- Retention: `runs/` pruned after 90 days **except** runs referenced by a
  still-open ledger position or an unresolved exoneration proposal;
  decision summaries, outcome records, sealed epoch manifests, and source-call
  events are retained; raw run inboxes may expire. Market blobs are retained
  while referenced and garbage-collected only after a reachability scan over all
  retained manifests. This preserves exact RSI reproduction without retaining
  duplicate candles per run
- Active resolution, discovery, and source-call JSONL files rotate monthly into
  immutable compressed segments with a hash index. Event summaries and referenced
  feature/outcome hashes are permanent; raw social text follows run retention.
  Failed-run inboxes expire after the configured inbox retention unless pinned
  by an incident
- The host archive is outside git. The runbook backs up sealed manifests,
  structured records, and referenced blobs to an operator-controlled encrypted
  destination; audit reports backup age, and garbage collection refuses to run
  without a verified backup

## As-of bundles (the leakage firewall)

When a post-run check detects a new decision entry (track/drop/ignore/revisit/
broadcast), the orchestrator writes `decisions/<decision-id>.json` in the same
run-completion step:

```json
{
  "decision_id": "d-2026-07-16-003",
  "run_id": "research-2026-07-16-1400",
  "decision_ts": "2026-07-16T14:12:00Z",
  "episode_id": "ep-solana-token-2026-07-16",
  "verdict": "track",
  "horizon_hours": 72,
  "confidence": 65,
  "signal_use": { "rsi": "driver", "attention_divergence": "confirm" },
  "provenance": ["telegram:channelname", "twitter:@handle"],
  "identity": { "chain": "…", "token_address": "…", "pair_address": "…" },
  "market_observed_at": "2026-07-16T14:00:00Z",
  "market_age_sec_at_decision": 720,
  "context_price_usd": 0.0000431,
  "liquidity_usd": 88000,
  "feature_spec_version": 1,
  "indicators": {
    "rsi_1h": { "value": 55.2, "previous": 52.8, "delta": 2.4,
      "last_closed_bar_ts": "2026-07-16T14:00:00Z", "valid": true,
      "input_hash": "sha256:…" },
    "rsi_4h": { "value": 48.7, "previous": 47.9, "delta": 0.8,
      "last_closed_bar_ts": "2026-07-16T12:00:00Z", "valid": true,
      "input_hash": "sha256:…" },
    "vol_z_1h": 1.1
  },
  "mentions": { "raw_24h": 41, "effective_24h": 9, "cluster_count": 3 },
  "strata": {
    "chain": "solana",
    "token_age_hours": 96,
    "liquidity_band": "30k-100k",
    "fear_greed": 61,
    "fear_greed_observed_at": "2026-07-16T00:00:00Z",
    "benchmark_volatility_percentile": 72
  },
  "source_scores_snapshot": {
    "run_id": "research-2026-07-16-1400",
    "hash": "sha256:…"
  },
  "benchmark_context": { "asset": "solana:sol", "price": 161.20,
    "observed_at": "2026-07-16T14:00:00Z" },
  "market_blob_refs": ["sha256:…"],
  "run_config_hash": "sha256:…"
}
```

Prices/indicators come from the run's own collector snapshots (already fetched,
no extra pre-decision API calls). The bundle is the sole source of what the
agent knew, but its pre-session quote is not treated as an executable entry.
The audit obtains the first eligible post-decision execution observation and
horizon observations under audit-metrics.md, then persists them once under
`outcomes/`. Benchmark observations use the same timestamps.

The orchestrator opens a pending ledger position when the track card is accepted.
The observation materialiser runs after every market-data job and during audit,
finalising its entry from the first post-decision observation. A drop moves it to
`exit-pending` until the first post-drop observation is available. Pending states
are never silently priced from stale context (INV-S10).

The host parses each new markdown decision card exactly once, validates its enums,
identity, timestamps, provenance, and feature references, and freezes the
structured fields above. Audits read this record, never re-parse mutable prose or
infer driver roles from a later report.

## Outcome observations

Outcome collection is idempotent and separate from metric aggregation. The
record key is `(subject_type, subject_id, horizon, observation_spec_version)`.
It stores target and benchmark timestamps/prices, pair used, any migration path,
liquidity, cost-model inputs, raw market blob hashes, provider/fetch metadata,
quality flags, and one status:

- `complete` — accepted observation
- `provider-pending` — retryable absence or outage
- `censored` — no defensible observation after bounded retries/fallbacks
- `terminal-loss` — verified rug or unrecoverable same-chain liquidity loss,
  with typed evidence

A disappeared pair is not terminal evidence. Resolution searches same-chain
pools by token address, records each hop, and keeps the original decision pair
in the bundle. No aggregate converts missing data to a loss or silently drops it.

## Epoch sealing

The weekly job freezes a cutoff and cohort manifest before any outcome fetch.
Records are written to a building epoch, verified against referenced hashes, and
published by atomic rename only after scorecard and source-score writes are
ready. A sealed epoch is immutable. Source-score updates carry `epoch_id` and
`effective_from`; the run completion commit and epoch seal either both succeed
or recovery treats the audit as incomplete and resumes it.

## Source-score lag

`source_scores_snapshot` names and hashes the sources.json copy the run started
with. Its hash-addressed structured copy survives run-folder pruning.
Evidence weighting within a run uses start-of-run scores; the weekly audit
updates scores only from source call events made **before** the previous score
cutoff.
A source can never be up-weighted by outcomes of the same window in which its
posts drove decisions — the feedback loop is cut by construction (INV-S14).

## Invariants

INV-S12 (attribution/scoring reads only this archive), INV-S14 (as-of bundle is
the sole evidence-time record, observations are causal, scores are lagged),
INV-S17 (RSI inputs/version are reproducible), INV-S18 (epochs and missingness
are idempotent), INV-S8 (bundle write happens before the run's completion
commit).
