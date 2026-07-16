---
description: Index of per-module architecture docs. Open the doc matching the module you are editing.
scope: project
status: active
last_verified: 2026-07-16
---

# Module docs

| Doc | Covers | Read before editing |
|---|---|---|
| [orchestrator.md](orchestrator.md) | Job registry, Cursor CLI sessions, journalled/idempotent run loop, locking, outbox → router, alpha lifecycle, sealed audit epochs, ledger + source scoring, rug-dock, recovery | `src/orchestrator/`, `src/cli.ts`, `ops/` |
| [collectors.md](collectors.md) | Social/market collectors, mention dedupe + clusters, source-call extraction, freshness, new pools, exact RSI contract, rate gate, atomic snapshots/provenance | `src/collectors/`, `src/lib/` |
| [agent-workspace.md](agent-workspace.md) | The bot's instructions, skills, knowledge store (index, research, narratives, sources), state schemas + decision cards, decision weighting, outbox, sandbox config | anything under `agent/` |
| [chat-agent.md](chat-agent.md) | Telegram bridge, minimal-orchestrator pattern, research sub-agents | `src/chat/`, `agent/skills/chat/`, `agent/skills/deep-research/` |
| [chains.md](chains.md) | Chain registry, per-provider id mapping, fail-closed rule, new-chain flow (API-only, no RPC) | anything passing a chain id to an upstream API |
| [token-resolution.md](token-resolution.md) | Canonical identity, isolated shortlist-bounded disambiguation, point-in-time dossier, ground-truth/proxy audit split, strict RSI-rule promotion | `src/lib/resolve.ts`, mention counting, watchlist entry creation |
| [research-queue.md](research-queue.md) | Candidate buffer, dedupe, priority, revisit/expiry/cap, immutable discovery audit records | enqueue/dequeue logic, the research job trigger |
| [security-gate.md](security-gate.md) | GoPlus/RugCheck field→flag mapping, hard-fail vs caution, market-quality preflight, fail-closed semantics | `src/collectors/market/security.ts` |
| [snapshot-archive.md](snapshot-archive.md) | Content-addressed archive, evidence bundles, causal outcome records, run journals, sealed epochs, retention/backup, source-score lag | run-loop archiving, attribution inputs, audit reads |
| [audit-metrics.md](audit-metrics.md) | Epoch/cohort rules, causal execution, honest P&L, horizons, calibration, RSI evaluation, broadcasts, source quality, funnel counterfactuals | `src/orchestrator/audit.ts` |
| [router.md](router.md) | In-repo SQLite router, HMAC intake, durable fanout, Telegram/Discord at-least-once, wallet lifecycle lane | `src/router/`, `src/lib/router-contract.ts` |
| [smart-wallets.md](smart-wallets.md) | Helius/Infura tracking, deterministic+LLM scoring, promotion/drop, mandatory lifecycle events | `src/wallets/`, wallet collectors |
| [chart-vision.md](chart-vision.md) | Offline SVG→PNG charts from archived OHLCV, manifests, vision as interpretive evidence | chart renderer, chart-sweep skill |
| [source-lifecycle.md](source-lifecycle.md) | FYP candidacy, lagged promote/demote, managed private X list sync (ADR 004) | `src/sources/`, `src/collectors/twitter/managed-list.ts`, `source-list` CLI |

ADRs live under [`docs/adr/`](../adr/). Provider knowledge under [`docs/knowledge/`](../knowledge/).
Parallel-worktree merge rules: [`../development.md`](../development.md).

Modules ship incrementally: flip matching `docs/INVARIANTS.md` rows to ENFORCED
only when the named enforcement site and tests exist. Prefer PARTIAL over
ENFORCED when the cited check covers only part of the claim. Update the module
doc in the same change if behaviour diverges.
