---
description: Provider knowledge — Neynar Farcaster API (feeds, search, likes, follows).
scope: project
status: active
last_verified: 2026-07-19
---

# Neynar

- Host: `api.neynar.com` only (gatedFetch confinement)
- Reads: for-you (`/v2/farcaster/feed/for_you`), following, trending, channel,
  cast search. Parse casts with username + fid + structured reaction counts.
  **Trending limit max is 10** (`ExceededMaxLimit` above that); for-you /
  following / channel still allow up to 50. Host clamps `max_items_per_feed`
  per kind before the request.
- Writes (allowlisted): like reaction, follow, unfollow. Cast publish and
  recast are forbidden in code.
- Auth: `NEYNAR_API_KEY`. Signer UUID under `~/.trenchcoat/farcaster/signer.json`
  after `pnpm dev:cli auth farcaster` (create account or attach to existing FID).
  Runtime probe: `probeFarcasterSigner` — likes/follows mutate only when Neynar
  reports `approved`; pending/rejected/unavailable write gate receipts only.
  Feed assessment (`assessFarcasterBundle`): live ≤6h, stale ≤24h, expired >24h;
  **future-dated timestamps count as expired** (audit A4 2061/2076 noise). For-you
  with no live casts or the repeated-two-hash stale pattern sets `skipAgent`.
  Account creation also needs `NEYNAR_WALLET_ID`, `FARCASTER_APP_FID`,
  `FARCASTER_APP_MNEMONIC`.
  Attach (`--fid` + custody mnemonic on stdin): Neynar `signed_key` then either
  (1) approve in the **Farcaster mobile app** — desktop HTTPS deeplinks no-op — or
  (2) fund custody with ~0.001 ETH on Optimism so the host can call `KeyGateway.add`
  (optional `OPTIMISM_RPC_URL`). Contract addresses from `@farcaster/core`.
  Source: Neynar managed-signer docs + farcaster contracts; verified 2026-07-17.
- Provenance: `farcaster:@username` → sourceId `fc_<username>` (rug-dock mapping)
- All snapshot items: `trust: untrusted-external`
- Agent never receives the API key or signer (scrubbed child env)
- Jobs: `farcaster-scan`, `fc-source-review`; watchlist-scan may use cast search
  when `research.farcaster_search.enabled` (operator/queue research does not)
