import type { CanonicalIdentity } from "../contracts/schemas.js"
import type { DiscordObservation } from "./schemas.js"

type DossierLike = Readonly<{
  market?: Readonly<{
    priceUsd?: number | null
    liquidityUsd?: number | null
    volume24hUsd?: number | null
    fdvUsd?: number | null
    buys24h?: number | null
    sells24h?: number | null
  }>
  security?: Readonly<{
    status?: string | null
    flags?: readonly string[]
  }>
  twitter?: Readonly<{
    postCount?: number
    authorCount?: number
    recentCount?: number
    posts?: readonly Readonly<{
      authorId?: string
      likes?: number | null
      views?: number | null
      replies?: number | null
      reposts?: number | null
    }>[]
  }>
}>

export function observationFromDossier(
  dossier: DossierLike | undefined,
  observedAt: string,
): DiscordObservation {
  const posts = dossier?.twitter?.posts ?? []
  const authorIds = [...new Set(posts.flatMap((p) => (
    p.authorId ? [p.authorId] : []
  )))].slice(0, 200)
  let likes = 0
  let views = 0
  let replies = 0
  let reposts = 0
  let knownEngagement = false
  for (const post of posts) {
    if (post.likes != null) { likes += post.likes; knownEngagement = true }
    if (post.views != null) views += post.views
    if (post.replies != null) { replies += post.replies; knownEngagement = true }
    if (post.reposts != null) { reposts += post.reposts; knownEngagement = true }
  }
  return {
    observedAt,
    priceUsd: dossier?.market?.priceUsd ?? null,
    liquidityUsd: dossier?.market?.liquidityUsd ?? null,
    volume24hUsd: dossier?.market?.volume24hUsd ?? null,
    fdvUsd: dossier?.market?.fdvUsd ?? null,
    buys24h: dossier?.market?.buys24h ?? null,
    sells24h: dossier?.market?.sells24h ?? null,
    securityStatus: dossier?.security?.status ?? null,
    securityFlags: [...(dossier?.security?.flags ?? [])].slice(0, 32),
    xPostCount: dossier?.twitter?.postCount ?? null,
    xAuthorCount: dossier?.twitter?.authorCount ?? null,
    xRecentCount: dossier?.twitter?.recentCount ?? null,
    xKnownLikes: knownEngagement ? likes : null,
    xKnownViews: views > 0 ? views : null,
    xKnownReplies: knownEngagement ? replies : null,
    xKnownReposts: knownEngagement ? reposts : null,
    xAuthorIds: authorIds,
  }
}

export function observationFromCollect(args: Readonly<{
  identity: CanonicalIdentity
  fetchedAt: string
  market?: DossierLike["market"]
  security?: DossierLike["security"]
  twitter?: DossierLike["twitter"]
}>): DiscordObservation {
  return observationFromDossier({
    ...(args.market ? { market: args.market } : {}),
    ...(args.security ? { security: args.security } : {}),
    ...(args.twitter ? { twitter: args.twitter } : {}),
  }, args.fetchedAt)
}
