---
description: ADR — Earlier token discovery via persistent cashtag social bridge, host MQ-fail watching downgrade, and live GeckoTerminal new-pools feed.
scope: project
status: accepted
last_verified: 2026-08-12
read_when:
  - Editing social-cashtag-bridge, new-pools-feed, new-pools-enqueue, discovery-log, or research discovery config (schema 26).
  - Changing watchlist tracking vs watching rules after market-quality fail.
---

# ADR 046 — Earlier token discovery

## Context

Social scans often see cashtag-only chatter with no contract address in the
same run. The CA-only research-candidates path then misses those tokens
(FIH-style cases). Docs also described a GeckoTerminal new-pools discovery
path that the host did not run.

## Decision

1. **Persistent cashtag social bridge.** After `list-scan` and
   `farcaster-scan`, the host scans sealed social inbox items for cashtags.
   It merges independent authors into
   `state/social-cashtag-clusters.json` across runs. When a cluster reaches
   `research.social_cashtag_bridge.min_authors` (default ≥2) inside the
   window, the host resolves and enqueues research. The CA fast lane
   (`research-candidates.json`) stays unchanged and CA-only.
2. **Host auto-downgrade on market-quality fail.** When a track proposal
   passes security and fails market-quality, the host sets watchlist status
   to `watching` instead of reject. No ledger position opens. Research
   broadcasts for those subjects fail the mechanical gate with
   `market-quality-watching`.
3. **Live GeckoTerminal new-pools feed.** On `list-scan`, the host fetches
   new pools for `new_pools_feed.chains`, applies age and security filters,
   and enqueues survivors even when market-quality fails. MQ-fail survivors
   stay on the watching-only outcome path after research. Rejects and
   accepts append `archive/discovery-log.jsonl`.

## Consequences

- New state file: `agent/state/social-cashtag-clusters.json`.
- New archive log: `~/.trenchcoat/archive/discovery-log.jsonl` (writer
  shipped; audit `filter_recall` reader may still be deferred).
- Config schema **26** adds `research.social_cashtag_bridge` and
  `new_pools_feed` via `migrateConfigToV26`.
- Agent skills keep research nominations CA-only. The host owns cashtag
  and new-pools enqueue.
