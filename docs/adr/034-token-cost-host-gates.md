---
description: Host gates that cut Cursor session volume — batched x-scan, host alpha ack, claim-only worthiness + cache, distill LLM fractions, review bullets, research hints, chat turn caps.
scope: project
status: accepted
date: 2026-07-23
supersedes: []
---

# ADR 034 — Token-cost host gates

## Context

Cursor session volume was dominated by KeepAlive x-scan (one full `list-scan`
agent session per target per round), plus per-proposal worthiness, channel
distill, and large duplicated prompt prose. Mechanical work (no-thesis alpha
acks, duplicate broadcasts, report bullets) does not need a model.

## Decision

1. **Batched x-scan:** one `list-scan` per round over all post-bearing target
   bundles; `includeAlphaManifest: true` once per round; cursors advance only
   after batch `exitCode === 0`.
2. **list-scan `skipAgent`:** when `postCount === 0` and host-acked alpha leaves
   zero `needs-agent` paths (`collectionStatus: no-signal`).
3. **Host alpha ack:** `classifyAlphaMessage` + tombstones under
   `state/research/alpha-ack-*`; merge into digest before
   `validateAndPurgeAlphaDigest` (INV-Q1/Q2). telegram-alpha may skip agent when
   the agent-facing manifest is empty (`host-alpha-ack-only`).
4. **Worthiness:** mechanical pre-gate; claim+refs+history only (no `agent.md`,
   no proposal prose); 48h cache at `state/broadcast-worthiness-cache.json`
   keyed by `{subject, claimHash}`.
5. **Distill:** `llm_budget_fraction` 0.5 always; when staged events this run ≥
   `hot_day_min_staged_events` (20), use `hot_day_llm_budget_fraction` 0.25.
   Message budgets (ADR 033) unchanged. Receipt reason `llm-budget-fraction`.
6. **Review:** host writes `review-reports-summary` ≤280-char bullets; agent
   opens full `agent.md` only when relevant.
7. **Research hint:** host writes `research-candidates-hint.json` (path-only);
   agent still authors `research-candidates.json`; host validates post-session.
8. **Chat:** rotate on idle 30m **or** `turn_count_max` 40 **or**
   `max_prompt_chars` 12_000 (Discord conversation mirrors turn cap).
9. **Prompt dedupe:** slim `AGENTS.md`; shared
   `skills/_shared/broadcast-checklist.md`; job prompts point at skills.

Config schema **19**.

## Consequences

- Fewer composer sessions per x-scan round (~3–4× fewer).
- Worthiness/distill spend drops on hot days without lowering Discord message
  caps.
- INV-B2 still requires worthiness approval (or cache hit of a prior approval);
  host never invents broadcast text.
- INV-Q1/Q2 satisfied by host tombstones with byte-verified hashes.

## See also

- [014-broadcast-worthiness.md](014-broadcast-worthiness.md)
- [033-hot-day-broadcast-lane-budgets.md](033-hot-day-broadcast-lane-budgets.md)
