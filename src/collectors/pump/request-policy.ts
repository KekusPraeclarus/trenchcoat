export type PumpRequestDecision =
  | Readonly<{ allow: true, reason: string }>
  | Readonly<{ allow: false, reason: string }>

const PUMP_HOSTS = new Set([
  "pump.fun",
  "www.pump.fun",
  "frontend-api-v3.pump.fun",
  "frontend-api-v2.pump.fun",
])

const PRIVY_HOSTS = new Set([
  "auth.privy.io",
])

const BLOCKED_HOST_SUFFIXES = [
  "googletagmanager.com",
  "google-analytics.com",
  "posthog.com",
  "walletconnect.com",
  "explorer-api.walletconnect.com",
  "moonpay.com",
  "swap-api",
  "rpc.",
  "alchemy.com",
  "helius-rpc.com",
  "launchdarkly.com",
  "appsflyersdk.com",
]

const BLOCKED_PUMP_HOSTS = new Set([
  "solana-mainnet.pump.fun",
  "swap-api.pump.fun",
])

export type PumpAllowedPost = Readonly<{
  host: string
  path: string
  operation?: string
}>

const DEFAULT_AUTH_REFRESH_POSTS: readonly PumpAllowedPost[] = [
  { host: "auth.privy.io", path: "/api/v1/sessions" },
]

/** Read-only SPA queries from probe-2026-08-13. Never register, swap, or RPC. */
const DEFAULT_PUMP_READ_POSTS: readonly PumpAllowedPost[] = [
  { host: "frontend-api-v3.pump.fun", path: "/profiles/verified" },
  { host: "frontend-api-v3.pump.fun", path: "/users/batch" },
  { host: "frontend-api-v3.pump.fun", path: "/coins-v2/mints" },
]

const ENGAGEMENT_PATH_RE = /\/(like|unlike|follow|unfollow)(\/|$)/iu
const DISCOVER_BLOCK_PATH_RE = /\/(like|unlike|follow|unfollow|register|swap|trade|create-coin|dm)(\/|$)/iu

function isPumpHost(host: string): boolean {
  return PUMP_HOSTS.has(host) || /^frontend-api-v\d+\.pump\.fun$/u.test(host)
}

function isCloudflareChallenge(path: string): boolean {
  return path.startsWith("/cdn-cgi/challenge-platform/")
}

/**
 * Fail-closed SPA request gate. Read GET/HEAD on pump.fun, frontend-api, and
 * Privy. POST allowlist is Privy session refresh plus FAFO read queries.
 * Like/follow/unfollow POSTs need mutationMode. RPC and swap hosts stay
 * blocked.
 */
export function classifyPumpRequest(
  method: string,
  url: string,
  opts: Readonly<{
    allowedPosts?: readonly PumpAllowedPost[]
    mutationMode?: boolean
  }> = {},
): PumpRequestDecision {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allow: false, reason: "invalid-url" }
  }

  const host = parsed.hostname.toLowerCase()
  const path = parsed.pathname
  const verb = method.toUpperCase()

  if (BLOCKED_PUMP_HOSTS.has(host)) {
    return { allow: false, reason: `blocked-host:${host}` }
  }

  if (
    BLOCKED_HOST_SUFFIXES.some((suffix) => (
      host === suffix || host.endsWith(`.${suffix}`) || host.includes(suffix)
    ))
  ) {
    return { allow: false, reason: `blocked-host:${host}` }
  }

  if (/\/(swap|trade|create-coin|dm|message|walletconnect)/iu.test(path)) {
    return { allow: false, reason: `blocked-path:${path}` }
  }

  const isPump = isPumpHost(host)
  const isPrivy = PRIVY_HOSTS.has(host)

  if (verb === "GET" || verb === "HEAD") {
    if (isPump || isPrivy) {
      return { allow: true, reason: "read" }
    }
    return { allow: false, reason: `unknown-host:${host}` }
  }

  if (verb === "POST") {
    if ((isPump || isPrivy) && isCloudflareChallenge(path)) {
      return { allow: true, reason: "cloudflare-challenge" }
    }
    if (opts.mutationMode && isPump && ENGAGEMENT_PATH_RE.test(path)) {
      return { allow: true, reason: `engagement-post:${host}${path}` }
    }
    const allowlist = [
      ...DEFAULT_AUTH_REFRESH_POSTS,
      ...DEFAULT_PUMP_READ_POSTS,
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

/**
 * Discover-only: continue unread POSTs on pump/privy hosts so FAFO can
 * record paths. Still block swap, rpc, analytics, and like/follow.
 */
export function classifyPumpDiscoverObserve(
  method: string,
  url: string,
): PumpRequestDecision {
  const base = classifyPumpRequest(method, url)
  if (base.allow) return base
  if (!base.reason.startsWith("post-not-allowlisted:")) return base
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return base
  }
  const host = parsed.hostname.toLowerCase()
  const path = parsed.pathname
  if (ENGAGEMENT_PATH_RE.test(path)) return base
  if (DISCOVER_BLOCK_PATH_RE.test(path)) return base
  if (!isPumpHost(host) && !PRIVY_HOSTS.has(host)) return base
  return { allow: true, reason: `discover-observe-post:${host}${path}` }
}
