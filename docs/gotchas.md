---
description: Capture-on-surprise scratchpad. Write one bullet the moment a session surprises you; drain into proper homes during context maintenance.
scope: project
status: active
last_verified: 2026-07-19
---

# Gotchas

Write entries immediately, while the evidence is in context. Each entry: date, what
surprised you, what the correct understanding is. Maintenance promotes entries into
knowledge files, invariants, ADRs, or architecture docs — an entry surviving a
maintenance pass is a routing failure.

## Entries

- **2026-07-19** — list-scan failed twice with Zod `too_big` on snapshot `items`
  (max 500). Cause was `list-scan-alpha-manifest` (one item per pending
  `alpha-queue/` path) after preview-first Telegram ingested 516 files — not
  Twitter scrape size. Manifests now cap + `truncated=N`.
- **2026-07-19** — farcaster-scan Neynar HTTP 400 from ~09:13 UTC: stale for-you
  triggered trending fallback with `limit=25`, but `/feed/trending` now rejects
  limit > 10 (`ExceededMaxLimit`). for-you/following still accept 25. A later
  dirty seed redeploy also wiped live `farcaster.enabled` + `bot_fid` — restore
  from `~/.trenchcoat/backups/config-20260719T084255Z.json` after fixing code.
