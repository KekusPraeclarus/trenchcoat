---
description: Playwright burner-profile scraping and host-only managed-list mutations for X/Twitter.
scope: knowledge
status: active
last_verified: 2026-07-19
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
- Per-target isolation: a closed page/context/browser relaunches the read-only
  session **once**, then continues remaining targets; collect fails only when
  zero targets complete (`scrapeTargetsWithRecovery`)
- Journal failure codes use `classifyRunFailureCode` — do **not** match bare
  `config` against Playwright stderr (`--disable-field-trial-config` falsely
  became `config-error` on 2026-07-19). Browser-closed → `collector-error`
- Research token search waits for `article[data-testid=tweet]` after navigation,
  soft-retries once on empty, and falls back from Latest (`f=live`) to Top when
  Latest returns zero posts. Host queries: CA, `$SYMBOL`, `SYMBOL chain`.

## list-scan cadence

- Launchd polls every 15m; `ops/run-job-jittered.sh` gates real runs to uniform
  [30m, 1h45m] after each success (2026-07-19; was 3h15m–4h45m). Farcaster uses
  the same script with a separate branch — do not assume shared constants.
- Backoff persists in `~/.trenchcoat/var/list-scan.next` across redeploy; delete
  to apply a shorter gate immediately after a cadence change.

## FYP engagement manifest

- `list-scan` collection writes `inbox/<run-id>/x-fyp-eligible.json` — host-derived
  manifest of FYP post ids and authors eligible for engagement this run
- Bot proposals must reference only that manifest; host rejects off-FYP targets
- Loader: `src/orchestrator/x-fyp-eligible.ts` (live inbox or sealed archive)

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
  `DestroyFriendships` (and friendship aliases). The guard also allows the REST
  fallback `/1.1/friendships/(create|destroy).json` (`isAllowedEngagementRestUrl`)
  since X issues follow/unfollow over that endpoint on some flows. Posts, replies,
  DMs, retweets, quotes, bookmarks, and list mutations are blocked.
- Subscription-state dedupe (proposal time, `src/social/x-engagement.ts`): after
  FYP binding and before daily counters, reject choices the account already
  reflects — `already_liked` (post in `likedPostIds` or a verified like receipt),
  `already_following` (handle in `followedHandles`, case-insensitive),
  `not_following` (unfollow of a handle not in `followedHandles`), and
  `pending_duplicate` (same action+target with an accepted decision whose
  `actionId` is still pending). These are runId-independent so a replayed proposal
  never re-attempts a settled action, and none of them bump `daily.*`.
- Desired-state execution: wait for tweet/profile shell, fail fast on
  login/challenge pages, scoped `[data-testid]` / role selectors, bounded
  post-action verification retries. Like controls are scoped to the article
  that owns the exact status id (`tweetArticleCssForPostId`) so quotes/recs are
  never clicked. Click timeouts do not end settlement: the executor observes the
  allowlisted `FavoriteTweet` response, then verifies UI state and may settle as
  `verified-after-attempt-error`. Receipts carry an optional `outcome` stage
  (`already-satisfied` | `verified` | `verified-after-attempt-error` |
  `ambiguous` | `failed-before-mutation`) plus bounded `attemptError` /
  `verificationError`. Success is never invented when a verifier is absent.
  Follow/unfollow stay primaryColumn-scoped with bounded hydration retry; non-
  followable profiles return `failed-before-mutation` (`account_not_followable`).
- Pending reconciliation: at the start of each live engagement pass, old
  `pendingActionIds` are probed read-only. Desired state present → settle;
  definitively absent only after successful negative verification + cooldown
  (`PENDING_ABSENT_COOLDOWN_MS`); otherwise leave pending. Ambiguous mutations
  are never auto-replayed (duplicate click can unlike/unfollow).
- Health: `state/x-bot-health.json` — last verified action, last failure,
  consecutive failures (updated only on live execution; not dry-run/canary/policy).
  Any verified receipt in a batch resets `consecutiveFailures`; only
  all-ambiguous batches increment it. `xBotHealthEscalation` flags the executor
  unhealthy once `consecutiveFailures` reaches `X_BOT_HEALTH_ESCALATION_THRESHOLD`
  (3); further mutations archive `bot-health-blocked.json` and stop until a
  verified read-only reconciliation or explicit `recoverXBotHealth` clears the
  condition. The engagement status probe surfaces this as `botHealthEscalation`.
- Tweet parse (`parseTwitterSearchPage`) builds the browser callback via
  `new Function(...)` so tsx/esbuild cannot inject `__name` helpers into
  Playwright's `evaluateAll` realm (that previously crashed live scrapes).
- FYP confinement: host writes `inbox/<run-id>/x-fyp-eligible.json`; dry-run
  loads that manifest from live inbox or sealed archive.
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
