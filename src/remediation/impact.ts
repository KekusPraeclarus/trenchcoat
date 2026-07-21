/**
 * Deterministic path → source/job impact registry for remediation.
 * Model diagnosis may widen affectedSources/Jobs; never narrow host scope.
 */

export type ImpactScope = Readonly<{
  sources: readonly string[]
  jobs: readonly string[]
  unknownMarketImpact: boolean
}>

const PATH_IMPACTS: ReadonlyArray<Readonly<{
  match: RegExp
  sources: readonly string[]
  jobs: readonly string[]
}>> = [
  {
    match: /^src\/collectors\/twitter\//u,
    sources: ["x-home-fyp", "x-operator-list", "x-managed-list"],
    jobs: ["list-scan", "x-scan", "narrative-scan"],
  },
  {
    match: /^src\/orchestrator\/x-scan-loop\.ts$/u,
    sources: ["x-home-fyp", "x-operator-list", "x-managed-list"],
    jobs: ["list-scan", "x-scan"],
  },
  {
    match: /^src\/orchestrator\/collect\.ts$/u,
    sources: ["x-home-fyp", "x-operator-list", "x-managed-list"],
    jobs: ["list-scan", "telegram-alpha"],
  },
  {
    match: /^src\/orchestrator\/narrative-/u,
    sources: ["x-home-fyp", "x-operator-list"],
    jobs: ["narrative-scan"],
  },
  {
    match: /^src\/collectors\/farcaster\//u,
    sources: ["farcaster"],
    jobs: ["farcaster-scan"],
  },
  {
    match: /^src\/collectors\/telegram\//u,
    sources: ["telegram-alpha"],
    jobs: ["telegram-alpha"],
  },
  {
    match: /^src\/collectors\/fomo\//u,
    sources: ["fomo"],
    jobs: ["fomo-signal-scan", "fomo-trader-sync"],
  },
  {
    match: /^src\/collectors\/market\//u,
    sources: ["coingecko", "dexscreener"],
    jobs: ["narrative-scan", "watchlist-scan", "chart-sweep"],
  },
]

const SAFE_DOC_TEST = /^(docs\/|tests\/|config\/seed\.example\.json$)/u

/**
 * Derive host impact from changed paths. Unknown market-affecting paths
 * set unknownMarketImpact and block automatic correction.
 */
export function impactFromChangedPaths(paths: readonly string[]): ImpactScope {
  const sources = new Set<string>()
  const jobs = new Set<string>()
  let unknownMarketImpact = false

  for (const path of paths) {
    if (SAFE_DOC_TEST.test(path)) continue
    if (
      path.startsWith("src/remediation/")
      || path.startsWith("src/harness/")
      || path.startsWith("src/router/")
      || path.startsWith("src/chain-integration/")
    ) {
      continue
    }

    let matched = false
    for (const rule of PATH_IMPACTS) {
      if (rule.match.test(path)) {
        matched = true
        for (const s of rule.sources) sources.add(s)
        for (const j of rule.jobs) jobs.add(j)
      }
    }

    if (!matched && path.startsWith("src/")) {
      // Orchestrator/lib/prompts/config changes may affect market calls
      if (
        path.startsWith("src/orchestrator/")
        || path.startsWith("src/lib/")
        || path.startsWith("src/prompts/")
        || path === "src/lib/config.ts"
      ) {
        unknownMarketImpact = true
      }
    }
  }

  return {
    sources: [...sources].sort(),
    jobs: [...jobs].sort(),
    unknownMarketImpact,
  }
}

/** Model may only widen host scope, never shrink it. */
export function mergeImpactScopes(
  host: ImpactScope,
  modelWiden?: Readonly<{
    sources?: readonly string[]
    jobs?: readonly string[]
  }>,
): ImpactScope {
  const sources = new Set(host.sources)
  const jobs = new Set(host.jobs)
  for (const s of modelWiden?.sources ?? []) {
    if (typeof s === "string" && s.length > 0 && s.length <= 64) sources.add(s)
  }
  for (const j of modelWiden?.jobs ?? []) {
    if (typeof j === "string" && j.length > 0 && j.length <= 64) jobs.add(j)
  }
  return {
    sources: [...sources].sort(),
    jobs: [...jobs].sort(),
    unknownMarketImpact: host.unknownMarketImpact,
  }
}
