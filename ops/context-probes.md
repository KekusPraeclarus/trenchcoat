# Context Probes

Golden questions a fresh agent should answer from the context graph alone.
Run during context maintenance; treat failures as selection bugs, not knowledge bugs.
See `~/.cursor/skills/context-engineering/refs/context-probes.md`.

| ID | Type | Question | Expected pointer or fact | Last result | Date |
|----|------|----------|--------------------------|-------------|------|
| P1 | recall | Which broadcast severity bypasses the daily budget, and what still constrains it? | `urgent` bypasses; schema check + failsafe ceiling (default 10/day, hitting it = incident) → docs/architecture/orchestrator.md "Outbox → router", INV-B4 | pass | 2026-07-16 |
| P2 | recall | Who is allowed to write `state/sources.json`, and why is that restricted? | Only deterministic host code: audit scoring maths, rug-shill dock, operator undock/confirm, neutral auto-registration; never a model session, so shilled content can't vouch for its own source → INV-S7/S12, agent-workspace.md | pass | 2026-07-16 |
| P5 | recall | A candidate surfaces on a chain we don't support — what happens, and how do we add the chain? | Fail-closed: no registry entry or no scanner → never `tracking`, rejection logged for audit; adding = registry entry + provider id verification, no RPC (docs/architecture/chains.md) | pass | 2026-07-16 |
| P6 | recall | Why can't the audit accidentally grade a decision with hindsight? | The as-of bundle freezes evidence; execution/outcomes use immutable post-event observations; a sealed epoch freezes cohort/versions; source scores lag one cycle → INV-S14/S18, snapshot-archive.md | pass | 2026-07-16 |
| P3 | artifact | Adding Farcaster (Neynar) as a data source — which files change? | src/collectors/ (new client behind rate gate), orchestrator jobs registry, sources.json auto-registration, TECHNICAL-SPEC source table; per docs/architecture/collectors.md + README index | pass | 2026-07-16 |
| P4 | continuation | What is the offline vs live acceptance status of the implementation? | Offline `pnpm test:all` green; live E2E blocked on credentials documented in ops/LIVE-E2E-BLOCKERS.md; container isolation smoke passes; many INVARIANTS still GAP/PARTIAL until live canaries and remaining post-run checks land | pass | 2026-07-16 |

## Failure log

Record each failed run and the graph fix that resolved it, so recurring breakage
patterns become visible.

- (none yet)
