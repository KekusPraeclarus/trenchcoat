---
description: Playwright burner-profile scraping and host-only managed-list mutations for X/Twitter.
scope: knowledge
status: active
last_verified: 2026-07-16
---

# X / Twitter (Playwright)

## Auth profile

- Path: `~/.trenchcoat/twitter-profile/` (not under `agent/`, not in the repo)
- Create/refresh: `pnpm dev:cli auth twitter` (headed; operator completes login)
- Session marker: `storage-state.json` mode 600; scrapes refuse without it
- Challenges → fail closed with re-auth instruction; never auto-solve

## Read-only scrape

- Module: `src/collectors/twitter/scrape.ts`
- Route guard aborts every non-GET/HEAD/OPTIONS method
- Targets from config v4: FYP + two operator lists + managed list URL when set
- Cross-target dedupe by post id; keep first-seen provenance

## Managed-list mutations (host only)

- Module: `src/collectors/twitter/managed-list.ts`
- One-time create: `pnpm dev:cli auth twitter --create-managed-list`
- Persists `twitter.managed_list.list_id` / `list_url` into host config and
  `source-lifecycle.json`
- Allowed GraphQL operation names only: `CreateList`, `ListAddMember`,
  `ListRemoveMember`
- When resolving operation names, prefer JSON body `operationName` over the URL
  path segment — X often posts to `.../graphql/<hash>/query` with the real name
  in the body. Path-only parsing would mis-classify mutations as `query`.
- Wrong list id → hard refuse (list-ID confinement)
- Runtime agent has no access to this synchronizer

## Engagement mutations

- Module: `src/collectors/twitter/engagement.ts`
- Bot writes choices to `reports/<run-id>/x-engagement.json`
- Applied after the agent session; default throttle is **2 likes / 10 minutes**
  (`twitter.engagement.likes_per_window` / `like_window_minutes`; schema allows
  higher — INV-S22 PARTIAL until capped in code)
- Allowed ops: `FavoriteTweet`, `UnfavoriteTweet`, `CreateFriendships`,
  `DestroyFriendships` (and friendship aliases). Posts, replies, DMs, retweets,
  quotes, bookmarks, and list mutations are blocked.
- CLI: `pnpm dev:cli x-engagement status`, `pnpm dev:cli x-engagement dry-run <run-id>`

## Operator probes

```bash
pnpm dev:cli probe twitter          # four targets + lifecycle + engagement summary
pnpm dev:cli source-list review --dry-run
pnpm dev:cli source-list sync
pnpm dev:cli x-engagement dry-run <run-id>
```

## Related

- [ADR 004](../adr/004-dynamic-x-list-lifecycle.md)
- [source-lifecycle.md](../architecture/source-lifecycle.md)
- INV-R2, INV-S21, INV-S22
