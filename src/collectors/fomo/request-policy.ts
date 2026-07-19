export type FomoRequestDecision =
  | Readonly<{ allow: true, reason: string }>
  | Readonly<{ allow: false, reason: string }>

const FOMO_HOSTS = new Set([
  "fomo.family",
  "www.fomo.family",
  "prod-api.fomo.family",
])

const PRIVY_HOSTS = new Set([
  "auth.privy.io",
])

const BLOCKED_HOST_SUFFIXES = [
  "googletagmanager.com",
  "google-analytics.com",
  "posthog.com",
  "app-actions.fomo.family",
  "walletconnect.com",
  "explorer-api.walletconnect.com",
  "moonpay.com",
  "rpc.",
  "alchemy.com",
  "helius-rpc.com",
]

/** Exact read-query POSTs discovered by probe and approved for production */
export type FomoAllowedPost = Readonly<{
  host: string
  path: string
  operation?: string
}>

const DEFAULT_AUTH_REFRESH_POSTS: readonly FomoAllowedPost[] = [
  { host: "auth.privy.io", path: "/api/v1/sessions" },
]

/** Read-only SPA bootstraps / list queries discovered 2026-07-19 — never trades or transfers */
const DEFAULT_FOMO_READ_POSTS: readonly FomoAllowedPost[] = [
  { host: "prod-api.fomo.family", path: "/v2/users" },
  { host: "prod-api.fomo.family", path: "/proxy/trendingTokens" },
  { host: "prod-api.fomo.family", path: "/proxy/mostHeld" },
  { host: "prod-api.fomo.family", path: "/proxy/filterTokens" },
  { host: "prod-api.fomo.family", path: "/proxy/tokenDetails" },
  { host: "prod-api.fomo.family", path: "/proxy/tokenWarnings" },
  { host: "prod-api.fomo.family", path: "/proxy/cryptoTokens" },
  { host: "prod-api.fomo.family", path: "/proxy/graduatedTokens" },
  { host: "prod-api.fomo.family", path: "/proxy/getBars" },
  { host: "prod-api.fomo.family", path: "/hodlers/friends" },
]

export function classifyFomoRequest(
  method: string,
  url: string,
  opts: Readonly<{
    allowedPosts?: readonly FomoAllowedPost[]
  }> = {},
): FomoRequestDecision {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allow: false, reason: "invalid-url" }
  }

  const host = parsed.hostname.toLowerCase()
  const path = parsed.pathname
  const verb = method.toUpperCase()

  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`) || host.includes(suffix))) {
    return { allow: false, reason: `blocked-host:${host}` }
  }

  const isFomo = FOMO_HOSTS.has(host) || host.endsWith(".fomo.family")
  const isPrivy = PRIVY_HOSTS.has(host)
  const isStaticAsset = /\.(js|css|woff2?|png|jpe?g|svg|ico|webmanifest|map)$/iu.test(path)

  if (verb === "GET" || verb === "HEAD") {
    if (isFomo || isPrivy || (isStaticAsset && isFomo)) {
      return { allow: true, reason: "read" }
    }
    return { allow: false, reason: `unknown-host:${host}` }
  }

  if (verb === "POST") {
    const allowlist = [
      ...DEFAULT_AUTH_REFRESH_POSTS,
      ...DEFAULT_FOMO_READ_POSTS,
      ...(opts.allowedPosts ?? []),
    ]
    const barePath = path.split("?")[0] ?? path
    const match = allowlist.find((entry) => (
      entry.host === host && barePath === entry.path
    ))
    if (match) return { allow: true, reason: `allowed-post:${match.host}${match.path}` }
    return { allow: false, reason: `post-not-allowlisted:${host}${path}` }
  }

  return { allow: false, reason: `mutation-verb:${verb}` }
}
