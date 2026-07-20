import type { TwitterPost } from "./session.js"

export type AccumulateUntilCursorResult = Readonly<{
  posts: readonly TwitterPost[]
  newestPostId?: string
  hitCursor: boolean
}>

/** Pure scroll/cursor accumulation — used by scrapeTargetUntilCursor and unit tests */
export function accumulatePostsUntilCursor(args: Readonly<{
  batches: readonly (readonly TwitterPost[])[]
  stopAtPostId?: string
}>): AccumulateUntilCursorResult {
  const seen = new Map<string, TwitterPost>()
  let newestPostId: string | undefined
  let hitCursor = false
  const stopAt = args.stopAtPostId?.trim() || undefined

  for (let pageIndex = 0; pageIndex < args.batches.length; pageIndex += 1) {
    const batch = args.batches[pageIndex]!
    if (pageIndex === 0 && batch[0]) newestPostId = batch[0].id
    for (const post of batch) {
      if (stopAt && post.id === stopAt) {
        hitCursor = true
        break
      }
      if (!seen.has(post.id)) seen.set(post.id, post)
    }
    if (hitCursor) break
  }

  return {
    posts: [...seen.values()],
    ...(newestPostId ? { newestPostId } : {}),
    hitCursor,
  }
}
