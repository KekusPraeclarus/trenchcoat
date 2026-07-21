---
description: Index of per-module architecture docs. Open the doc matching the module you are editing.
scope: project
status: active
last_verified: 2026-07-21
---

# Module docs

| Doc | Covers | Read before editing |
|---|---|---|
| [orchestrator.md](orchestrator.md) | Job registry (incl. wallet + harness-improve), Cursor CLI sessions, journalled/idempotent run loop, locking, outbox → router, alpha lifecycle, sealed audit epochs, ledger + source scoring, rug-dock, recovery | `src/orchestrator/`, `src/cli.ts`, `src/harness/`, `ops/` |
| [collectors.md](collectors.md) | Social/market collectors, mention dedupe + clusters, source-call extraction, freshness, new pools, exact RSI contract, rate gate, atomic snapshots/provenance | `src/collectors/`, `src/lib/` |
| [agent-workspace.md](agent-workspace.md) | The bot's instructions, skills, knowledge store (index, research, narratives, sources), state schemas + decision cards, decision weighting, outbox, sandbox config | anything under `agent/` |
| [chat-agent.md](chat-agent.md) | Telegram bridge, confirmation-gated research, deep-research sub-agents | `src/chat/`, `src/orchestrator/research.ts`, `agent/skills/chat/`, `agent/skills/deep-research/` |
| [discord-research.md](discord-research.md) | Private-guild Discord research bot (Gateway, isolated state, watch monitor) — **not** router webhook broadcasts | `src/discord/`, `chat.discord` config (schema 10+), ADR 010, ADR 012 |
| [discord-tracking.md](discord-tracking.md) | NL idea-tracking requests, durable match batches, gated research-first alerts, expiry, INV-D3–D8 | `src/discord/tracking-*.ts`, `chat.discord.tracking`, ADR 018, ADR 019 |
| [discord-chain-integration.md](discord-chain-integration.md) | Host lane: unknown `slug:address` → research/build/gate/push/deploy → research FIFO | `src/chain-integration/`, schema 12 `chain_integration`, ADR 016 |
| [incident-remediation.md](incident-remediation.md) | Hourly/weekly host incident remediation with Telegram high-risk approval and post-fix claim audit | `src/remediation/`, schema 14 `incident_remediation.revalidation`, ADR 017, INV-S27/S28 |
| [chains.md](chains.md) | Chain registry, per-provider id mapping, fail-closed rule, new-chain flow (API-only, no RPC) | anything passing a chain id to an upstream API |
| [token-resolution.md](token-resolution.md) | Canonical identity, isolated shortlist-bounded disambiguation, point-in-time dossier, ground-truth/proxy audit split, strict RSI-rule promotion | `src/lib/resolve.ts`, mention counting, watchlist entry creation |
| [research-queue.md](research-queue.md) | Candidate buffer, dedupe, priority, revisit/expiry/cap, operator Telegram/CLI path | `src/lib/research-queue.ts`, `src/orchestrator/research.ts`, research job |
| [security-gate.md](security-gate.md) | GoPlus/RugCheck field→flag mapping, hard-fail vs caution (incl. contextual mint / ADR 011), market-quality preflight, fail-closed semantics | `src/collectors/market/security.ts`, `src/orchestrator/research-verdict.ts` |
| [snapshot-archive.md](snapshot-archive.md) | Content-addressed archive, evidence bundles, causal outcome records, run journals, sealed epochs, retention/backup, source-score lag | run-loop archiving, attribution inputs, audit reads |
| [audit-metrics.md](audit-metrics.md) | Epoch/cohort rules, causal execution, honest P&L, horizons, calibration, RSI evaluation, broadcasts, source quality, funnel counterfactuals | `src/orchestrator/audit.ts` |
| [router.md](router.md) | KeepAlive SQLite router, HMAC intake, durable fanout, per-channel Telegram/Discord payloads (host-rendered; watchWindow ADR 013), wallet lifecycle lane | `src/router/`, `src/orchestrator/channel-render.ts`, `src/orchestrator/distill-session.ts`, `src/lib/router-contract.ts`, `src/lib/watch-window.ts` |
| [smart-wallets.md](smart-wallets.md) | Helius/Infura tracking, deterministic+LLM scoring, promotion/drop, mandatory lifecycle events | `src/wallets/`, wallet collectors |
| [chart-vision.md](chart-vision.md) | Offline SVG→PNG charts from archived OHLCV, manifests, vision as interpretive evidence | chart renderer, chart-sweep skill |
| [source-lifecycle.md](source-lifecycle.md) | FYP candidacy, lagged promote/demote, managed private X list (ADR 004) + Farcaster follow-graph (ADR 007) | `src/sources/`, `src/sources/fc-lifecycle.ts`, `src/collectors/twitter/managed-list.ts`, `src/collectors/farcaster/`, `source-list` / `fc-source` CLI |
| [harness-improvement.md](harness-improvement.md) | Sealed-scorecard hypotheses, confined worktrees, holdout evaluation, bounded-live canaries (ADR 005) | `src/harness/`, `tc harness` |

ADRs live under [`docs/adr/`](../adr/). Provider knowledge under [`docs/knowledge/`](../knowledge/).
Parallel-worktree merge rules: [`../development.md`](../development.md).

Modules ship incrementally: flip matching `docs/INVARIANTS.md` rows to ENFORCED
only when the named enforcement site and tests exist. Prefer PARTIAL over
ENFORCED when the cited check covers only part of the claim. Update the module
doc in the same change if behaviour diverges.
