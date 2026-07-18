---
title: Farcaster follow-graph as managed-list analog
status: accepted
date: 2026-07-17
---

# ADR 007 — Farcaster follow-graph as managed-list analog

## Context

X source lifecycle uses a private managed list: promote → add member, demote →
remove. Farcaster has no equivalent private list API. The personalized for-you
feed is driven by the account's follow graph and engagement.

## Decision

1. Treat the bot's **follow graph** as the managed-list analog.
2. Host-only `fc-source-review` promotes to follow and demotes to unfollow,
   capacity-capped, with fid confinement (only fids in `fc-source-lifecycle.json`).
3. Agent `farcaster-scan` may propose **likes only** (same-run for-you hashes);
   never follow/unfollow (parallel to INV-S22 separation of engagement vs list).
4. Keep Farcaster state in separate files (`fc-source-lifecycle.json`,
   `fc-engagement.json`) so X schemas and managed-list sync stay untouched.
5. Prefer Neynar REST over Playwright; store signer outside the repo.

## Consequences

- Enabling Farcaster requires a bot FID + approved signer (`auth farcaster`).
- Organic follows outside lifecycle are ignored by sync (managed subset only).
- Call-event / outcomes pipeline is platform-agnostic via provenance.

## Implementation status (2026-07-18)

- **Signer probe** — `probeFarcasterSigner` in `src/collectors/farcaster/signer.ts`
  queries Neynar signer status; likes and follow-graph sync mutate only when
  `status=approved`. Pending/rejected/unavailable paths write explicit gate
  receipts and perform no mutation.
- **Feed assessment** — `assessFarcasterBundle` in `scrape.ts` tiers casts
  live ≤6h / stale ≤24h / expired; rejects for-you when no live cast or a
  repeated-two-hash stale pattern; expired casts never enter inbox evidence or
  the FYP like allowlist.
- **Follow sync** — cursor-paginated following fetch, idempotent
  already-following/not-following handling, post-sync refetch, exact
  desired-vs-actual verification (`syncFollowGraph`).
- **Operator seed** — `tc fc-source seed <file> [--dry-run]` stages managed
  candidates via host-only lifecycle transitions (`config/fc-source-seed.example.json`).
- **Live E2E** — gated on `TRENCHCOAT_LIVE_E2E=1` + Neynar signer approval
  (`tests/e2e/farcaster-live.test.ts`).
