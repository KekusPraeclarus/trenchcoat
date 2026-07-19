import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import type { BroadcastItem } from "../contracts/schemas.js"
import { narrativeLogPath, NarrativeLogEntrySchema } from "./narrative-log.js"

export type SocialPlatform = "x" | "farcaster" | "telegram"

const PLATFORM_COVERAGE_CLAIMS = new Set(["rotation", "sentiment-collapse"])

/** Market / FOMO / attention provenance never counts as a second social platform */
const NON_SOCIAL_PREFIX =
  /^(?:coingecko|dexscreener|geckoterminal|market|fomo|feed|host|narrative):/iu

export function socialPlatformFromProvenance(raw: string): SocialPlatform | undefined {
  const value = raw.trim()
  if (NON_SOCIAL_PREFIX.test(value)) return undefined
  if (/^(?:twitter|x):@/iu.test(value)) return "x"
  if (/^farcaster:@/iu.test(value)) return "farcaster"
  if (/^telegram:/iu.test(value)) return "telegram"
  return undefined
}

export function collectSocialPlatforms(evidence: readonly string[]): ReadonlySet<SocialPlatform> {
  const platforms = new Set<SocialPlatform>()
  for (const item of evidence) {
    const platform = socialPlatformFromProvenance(item)
    if (platform) platforms.add(platform)
  }
  return platforms
}

export function platformCoverageLabel(
  platforms: ReadonlySet<SocialPlatform>,
): "X-only" | "Farcaster-only" | "Telegram-only" | undefined {
  if (platforms.size !== 1) return undefined
  if (platforms.has("x")) return "X-only"
  if (platforms.has("farcaster")) return "Farcaster-only"
  if (platforms.has("telegram")) return "Telegram-only"
  return undefined
}

export function claimRequiresPlatformCorroboration(type: string): boolean {
  return PLATFORM_COVERAGE_CLAIMS.has(type)
}

export function loadNarrativeEvidenceForSubject(
  agentRoot: string,
  subject: string,
): readonly string[] {
  const path = narrativeLogPath(agentRoot)
  if (!existsSync(path)) return []
  try {
    const real = realpathSync(path)
    if (!statSync(real).isFile()) return []
  } catch {
    return []
  }
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return []
  }
  const needle = subject.trim().toLowerCase()
  if (!needle) return []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const entry = NarrativeLogEntrySchema.safeParse(parsed)
    if (!entry.success) continue
    if (entry.data.slug.toLowerCase() !== needle) continue
    return [
      ...entry.data.evidence,
      ...(entry.data.sourceProvenanceIds ?? []),
    ]
  }
  return []
}

export function resolveSocialPlatformsForClaim(
  agentRoot: string,
  item: Readonly<{
    auditClaim: Readonly<{ type: string, subject: string }>
    refs: readonly string[]
  }>,
): ReadonlySet<SocialPlatform> {
  if (!claimRequiresPlatformCorroboration(item.auditClaim.type)) {
    return new Set()
  }
  const citesNarratives = item.refs.length === 0
    || item.refs.some((ref) => ref.startsWith("state/narratives/"))
  if (!citesNarratives) return new Set()
  return collectSocialPlatforms(
    loadNarrativeEvidenceForSubject(agentRoot, item.auditClaim.subject),
  )
}

/**
 * Rotation / sentiment-collapse with fewer than two social platforms stay visible
 * but cannot escalate past watch — market/FOMO provenance is not corroboration.
 */
export function capSeverityForPlatformCoverage(
  item: BroadcastItem,
  platforms: ReadonlySet<SocialPlatform>,
): BroadcastItem {
  if (!claimRequiresPlatformCorroboration(item.auditClaim.type)) return item
  if (platforms.size >= 2) return item
  if (item.severity === "watch") return item
  return { ...item, severity: "watch" }
}

export function annotatePlatformCoverageText(
  text: string,
  label: string | undefined,
): string {
  if (!label) return text
  if (text.includes(label)) return text
  const suffix = ` [${label}]`
  const max = 280
  if ([...text].length + [...suffix].length <= max) return `${text}${suffix}`
  const budget = max - [...suffix].length
  if (budget < 1) return label.slice(0, max)
  return `${[...text].slice(0, budget).join("")}${suffix}`
}
