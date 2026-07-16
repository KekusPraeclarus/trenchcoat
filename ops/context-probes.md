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
| P4 | continuation | What is the offline vs live acceptance status of the implementation? | Offline `pnpm test:all` green; live E2E blocked on credentials in ops/LIVE-E2E-BLOCKERS.md; many INVARIANTS still GAP/PARTIAL (INV-I5 container smoke still open) | pass | 2026-07-16 |
| P7 | recall | How does trenchcoat authenticate Cursor agent job sessions? | Cursor CLI login (`agent login` / `agent status`), headless `agent -p --trust --workspace agent/`; not `@cursor/sdk` / required `CURSOR_API_KEY` → ADR 003, docs/knowledge/cursor-cli.md | pass | 2026-07-16 |
| P8 | recall | What must stay true when merging parallel feature worktrees? | Integration owner exclusively merges `package.json`, `src/contracts/**`, `src/orchestrator/run.ts`, `docs/INVARIANTS.md`; cherry-pick non-overlapping files and reconcile duplicate APIs before declaring green → docs/development.md | pass | 2026-07-16 |
| P9 | recall | Who may add or remove members of the bot-managed X list, and from what evidence? | Only host lifecycle code after lagged settled direct bullish raw-CA outcomes; FYP text/model/engagement cannot promote; operator lists are immutable inputs → ADR 004, source-lifecycle.md, INV-S21 (PARTIAL until sealed outcomes feed review) | pass | 2026-07-16 |
| P10 | recall | Which X network mutations are allowed, and what must match before any membership change? | Only GraphQL `CreateList`/`ListAddMember`/`ListRemoveMember` in the host synchronizer; target list id must equal persisted managed list id; scrapers stay read-only → INV-R2, knowledge/x-playwright.md | pass | 2026-07-16 |
| P11 | recall | Where does the X burner Playwright profile live, and is it `browser-profile`? | `~/.trenchcoat/twitter-profile/` only; never under `agent/` or the repo; name is not `browser-profile` → knowledge/x-playwright.md, collectors.md | pass | 2026-07-16 |
| P12 | recall | Can the agent like FYP posts, and does that promote managed-list membership? | Agent owns like/follow choices (default ≤2 likes / 10 min; INV-S22 PARTIAL); engagement never writes managed-list or source scores → INV-S22, source-lifecycle.md | pass | 2026-07-16 |

## Failure log

Record each failed run and the graph fix that resolved it, so recurring breakage
patterns become visible.

- 2026-07-16 P8 fail: expected merge ownership lived only in this table. Fix: added
  `docs/development.md` and linked it from `docs/README.md`.
- 2026-07-16 P4 soft-fail: expected answer claimed container isolation smoke passes;
  graph only had INV-I5 PARTIAL. Fix: narrowed expected pointer to match LIVE-E2E
  blockers + invariant status.
