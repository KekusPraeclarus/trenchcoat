export type NarrativeSourceStatus = "probation" | "follow-eligible" | "followed" | "demoted"

const MAX_ACCEPTED_SLUGS = 64

export type NarrativeSource = Readonly<{
  handle: string
  sourceId: string
  status: NarrativeSourceStatus
  addedAt: string
  probationEndsAt: string
  lastEvaluatedAt?: string
  lastContributionAt?: string
  acceptedContributions: number
  distinctNarratives: number
  /** Distinct narrative slugs credited; distinctNarratives mirrors this length */
  acceptedNarrativeSlugs: readonly string[]
  contributionDays: readonly string[]
  hardDocked?: boolean
}>

export type NarrativeSourcesFile = Readonly<{
  schema: 1
  sources: readonly NarrativeSource[]
}>

export function emptyNarrativeSources(): NarrativeSourcesFile {
  return { schema: 1, sources: [] }
}

export function sourceIdForXHandle(handle: string): string {
  return `x_${handle.toLowerCase()}`
}

function slugSet(item: NarrativeSource): string[] {
  if (Array.isArray(item.acceptedNarrativeSlugs)) {
    return [...item.acceptedNarrativeSlugs]
  }
  return []
}

export function backfillNarrativeProbation(
  file: NarrativeSourcesFile,
  handles: readonly string[],
  addedAt: string,
  probationDays: number,
): NarrativeSourcesFile {
  return handles.reduce(
    (next, handle) => registerNarrativeProbation(next, handle, addedAt, probationDays),
    file,
  )
}

export function registerNarrativeProbation(
  file: NarrativeSourcesFile,
  handle: string,
  addedAt: string,
  probationDays: number,
): NarrativeSourcesFile {
  const normalized = handle.toLowerCase()
  const sourceId = sourceIdForXHandle(normalized)
  if (file.sources.some((item) => item.sourceId === sourceId && item.status !== "demoted")) {
    return file
  }
  const probationEndsAt = new Date(Date.parse(addedAt) + probationDays * 86_400_000).toISOString()
  return {
    schema: 1,
    sources: [
      ...file.sources.filter((item) => item.sourceId !== sourceId),
      {
        handle: normalized,
        sourceId,
        status: "probation",
        addedAt,
        probationEndsAt,
        acceptedContributions: 0,
        distinctNarratives: 0,
        acceptedNarrativeSlugs: [],
        contributionDays: [],
      },
    ],
  }
}

export function creditNarrativeContribution(
  file: NarrativeSourcesFile,
  args: Readonly<{
    handle: string
    narrativeSlug: string
    at: string
    creditedSlugs?: readonly string[]
  }>,
): NarrativeSourcesFile {
  const day = args.at.slice(0, 10)
  const slug = args.narrativeSlug.slice(0, 64)
  return {
    schema: 1,
    sources: file.sources.map((item) => {
      if (item.handle !== args.handle.toLowerCase()) return item
      const days = item.contributionDays.includes(day)
        ? item.contributionDays
        : [...item.contributionDays, day].slice(-90)
      const prior = args.creditedSlugs
        ? [...new Set([...args.creditedSlugs, ...slugSet(item)])]
        : slugSet(item)
      const nextSlugs = prior.includes(slug)
        ? prior.slice(0, MAX_ACCEPTED_SLUGS)
        : [...prior, slug].slice(-MAX_ACCEPTED_SLUGS)
      return {
        ...item,
        acceptedContributions: item.acceptedContributions + 1,
        acceptedNarrativeSlugs: nextSlugs,
        distinctNarratives: nextSlugs.length,
        contributionDays: days,
        lastContributionAt: args.at,
      }
    }),
  }
}

export function reviewNarrativeSources(
  file: NarrativeSourcesFile,
  args: Readonly<{
    nowIso: string
    minAccepted: number
    minDistinct: number
    demotionIdleDays: number
  }>,
): NarrativeSourcesFile {
  return {
    schema: 1,
    sources: file.sources.map((item) => {
      if (item.hardDocked) {
        return { ...item, status: "demoted" as const, lastEvaluatedAt: args.nowIso }
      }
      if (item.status === "probation" && Date.parse(args.nowIso) >= Date.parse(item.probationEndsAt)) {
        const contributingDays = item.contributionDays.length
        const distinct = slugSet(item).length || item.distinctNarratives
        if (
          item.acceptedContributions >= args.minAccepted
          && distinct >= args.minDistinct
          && contributingDays >= 3
        ) {
          return { ...item, status: "follow-eligible" as const, lastEvaluatedAt: args.nowIso }
        }
        return { ...item, status: "demoted" as const, lastEvaluatedAt: args.nowIso }
      }
      if (item.status === "followed") {
        const last = item.lastContributionAt ?? item.addedAt
        const idleDays = (Date.parse(args.nowIso) - Date.parse(last)) / 86_400_000
        if (idleDays >= args.demotionIdleDays) {
          return { ...item, status: "demoted" as const, lastEvaluatedAt: args.nowIso }
        }
      }
      return { ...item, lastEvaluatedAt: args.nowIso }
    }),
  }
}

export function markFollowed(
  file: NarrativeSourcesFile,
  handle: string,
  at: string,
): NarrativeSourcesFile {
  return {
    schema: 1,
    sources: file.sources.map((item) => (
      item.handle === handle.toLowerCase() && item.status === "follow-eligible"
        ? { ...item, status: "followed" as const, lastEvaluatedAt: at }
        : item
    )),
  }
}

export function markDemoted(
  file: NarrativeSourcesFile,
  handle: string,
  at: string,
): NarrativeSourcesFile {
  return {
    schema: 1,
    sources: file.sources.map((item) => (
      item.handle === handle.toLowerCase()
        ? { ...item, status: "demoted" as const, lastEvaluatedAt: at }
        : item
    )),
  }
}
