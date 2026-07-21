import type { DiscordObservation } from "./schemas.js"

export type MaterialReason =
  | "security-status"
  | "security-hard-fail"
  | "security-flags"
  | "price"
  | "liquidity"
  | "volume"
  | "fdv"
  | "x-authors"
  | "x-engagement"

export type MaterialChange = Readonly<{
  reason: MaterialReason
  label: string
  prior: string
  current: string
}>

const PRICE_PCT_MIN = 0.50
const DOUBLE_OR_HALF_MIN = 1.0
const X_AUTHORS_NET_UP_MIN = 50
const X_AUTHORS_NET_DOWN_MIN = 100

function pctChange(prior: number, current: number): number | undefined {
  if (!Number.isFinite(prior) || !Number.isFinite(current) || prior <= 0) return undefined
  return Math.abs((current - prior) / prior)
}

function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "unknown"
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(v < 1 ? 6 : 2)}`
}

function fmtNum(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "unknown"
  return String(v)
}

function doubledOrHalved(prior: number, current: number): boolean {
  return (pctChange(prior, current) ?? 0) >= DOUBLE_OR_HALF_MIN
}

export function detectMaterialChanges(
  baseline: DiscordObservation,
  current: DiscordObservation,
): MaterialChange[] {
  const out: MaterialChange[] = []

  // Security status/flags stay on the dossier for research gates; they do not
  // trigger watch-update broadcasts (flag churn is noisy and not tape)

  if (
    baseline.priceUsd != null && current.priceUsd != null
    && (pctChange(baseline.priceUsd, current.priceUsd) ?? 0) >= PRICE_PCT_MIN
  ) {
    out.push({
      reason: "price",
      label: "Price",
      prior: fmtUsd(baseline.priceUsd),
      current: fmtUsd(current.priceUsd),
    })
  }

  if (
    baseline.liquidityUsd != null && current.liquidityUsd != null
    && doubledOrHalved(baseline.liquidityUsd, current.liquidityUsd)
  ) {
    out.push({
      reason: "liquidity",
      label: "Liquidity",
      prior: fmtUsd(baseline.liquidityUsd),
      current: fmtUsd(current.liquidityUsd),
    })
  }

  if (
    baseline.volume24hUsd != null && current.volume24hUsd != null
    && doubledOrHalved(baseline.volume24hUsd, current.volume24hUsd)
  ) {
    out.push({
      reason: "volume",
      label: "24h volume",
      prior: fmtUsd(baseline.volume24hUsd),
      current: fmtUsd(current.volume24hUsd),
    })
  }

  if (
    baseline.fdvUsd != null && current.fdvUsd != null
    && doubledOrHalved(baseline.fdvUsd, current.fdvUsd)
  ) {
    out.push({
      reason: "fdv",
      label: "FDV",
      prior: fmtUsd(baseline.fdvUsd),
      current: fmtUsd(current.fdvUsd),
    })
  }

  const baseCount = baseline.xAuthorIds.length
  const curCount = current.xAuthorIds.length
  const netAuthors = curCount - baseCount
  if (netAuthors >= X_AUTHORS_NET_UP_MIN || netAuthors <= -X_AUTHORS_NET_DOWN_MIN) {
    const netLabel = netAuthors >= 0 ? `+${netAuthors}` : String(netAuthors)
    out.push({
      reason: "x-authors",
      label: "X authors",
      prior: fmtNum(baseCount),
      current: `${fmtNum(curCount)} (net ${netLabel})`,
    })
  }

  const baseEng = (baseline.xKnownLikes ?? 0) + (baseline.xKnownReplies ?? 0) + (baseline.xKnownReposts ?? 0)
  const curEng = (current.xKnownLikes ?? 0) + (current.xKnownReplies ?? 0) + (current.xKnownReposts ?? 0)
  if (
    baseline.xKnownLikes != null && baseline.xKnownReplies != null && baseline.xKnownReposts != null
    && current.xKnownLikes != null && current.xKnownReplies != null && current.xKnownReposts != null
    && baseEng > 0 && curEng > 0
    && (curEng >= baseEng * 2 || curEng <= baseEng * 0.5)
  ) {
    out.push({
      reason: "x-engagement",
      label: "X engagement",
      prior: fmtNum(baseEng),
      current: fmtNum(curEng),
    })
  }

  return out
}

const SECURITY_FLAG_GLOSS: Readonly<Record<string, string>> = {
  "honeypot": "honeypot / can't sell",
  "cannot-sell-all": "can't sell full balance",
  "mintable": "mintable supply",
  "mint-authority": "mint authority still live",
  "owner-can-change-balance": "owner can rewrite balances",
  "selfdestruct": "selfdestruct enabled",
  "sell-tax": "high sell tax",
  "buy-tax": "buy tax",
  "low-lp-lock": "LP poorly locked",
  "top-holder-concentration": "top holders too concentrated",
  "proxy-contract": "proxy / upgradeable contract",
  "cooldown": "trading cooldown",
  "anti-whale": "anti-whale limits",
  "blacklist": "blacklist capability",
  "freeze-authority": "freeze authority still live",
  "unverified-source": "contract source not verified",
}

function glossSecurityFlag(code: string): string {
  return SECURITY_FLAG_GLOSS[code] ?? code
}

function glossSecurityFlags(raw: string): string {
  if (raw === "none" || raw === "unknown") return raw
  return raw.split(", ").map(glossSecurityFlag).join(", ")
}

function parseUsdish(raw: string): number | undefined {
  const s = raw.trim()
  if (s === "unknown") return undefined
  const match = s.match(/^\$([\d.]+)([KMB])?$/iu)
  if (!match) {
    const n = Number(s)
    return Number.isFinite(n) ? n : undefined
  }
  let value = Number(match[1])
  const suffix = match[2]?.toUpperCase()
  if (suffix === "K") value *= 1_000
  if (suffix === "M") value *= 1_000_000
  if (suffix === "B") value *= 1_000_000_000
  return Number.isFinite(value) ? value : undefined
}

function ratioSuffix(prior: string, current: string): string {
  const p = Number(prior) || parseUsdish(prior)
  const c = Number(current) || parseUsdish(current)
  if (p == null || c == null || !Number.isFinite(p) || !Number.isFinite(c) || p <= 0) return ""
  if (c >= p * 2) return " (about doubled)"
  if (c <= p * 0.5) {
    const pct = Math.round(Math.abs((c - p) / p) * 100)
    return ` (about ${pct}% lower)`
  }
  const pct = Math.round(Math.abs((c - p) / p) * 100)
  return c > p ? ` (about ${pct}% higher)` : ` (about ${pct}% lower)`
}

function formatSecurityFlagsGloss(change: MaterialChange): string {
  const priorGloss = glossSecurityFlags(change.prior)
  const currentGloss = glossSecurityFlags(change.current)
  const priorClear = change.prior === "none"
  const currentClear = change.current === "none"
  if (!priorClear && currentClear) {
    return `- Security flags cleared: ${priorGloss} → none (scanner no longer flags ${priorGloss})`
  }
  if (priorClear && !currentClear) {
    return `- Security flags newly raised: none → ${currentGloss}`
  }
  return `- Security flags: ${priorGloss} → ${currentGloss}`
}

function formatSecurityFlagsFallback(change: MaterialChange): string {
  const priorClear = change.prior === "none"
  const currentClear = change.current === "none"
  if (!priorClear && currentClear) {
    if (change.prior === "unverified-source") return "Contract source looks verified now."
    return `${glossSecurityFlags(change.prior)} caution cleared.`
  }
  if (priorClear && !currentClear) {
    return `New security caution: ${glossSecurityFlags(change.current)}.`
  }
  return `Security flags shifted (${glossSecurityFlags(change.prior)} → ${glossSecurityFlags(change.current)}).`
}

function formatEngagementFallback(change: MaterialChange): string {
  const prior = Number(change.prior)
  const current = Number(change.current)
  if (Number.isFinite(prior) && Number.isFinite(current)) {
    if (current <= prior * 0.5) return `X engagement cooled hard (${change.prior} → ${change.current}).`
    if (current >= prior * 2) return `X engagement spiked (${change.prior} → ${change.current}).`
  }
  return `X engagement moved (${change.prior} → ${change.current}).`
}

export function formatMaterialChangeGloss(change: MaterialChange): string {
  switch (change.reason) {
    case "security-flags":
      return formatSecurityFlagsGloss(change)
    case "x-engagement":
      return `- X engagement (likes+replies+reposts): ${change.prior} → ${change.current}${ratioSuffix(change.prior, change.current)}`
    case "x-authors": {
      const netMatch = change.current.match(/\(net ([+-]?\d+)\)/u)
      const count = change.current.replace(/\s*\(net.*\)/u, "")
      const netSuffix = netMatch?.[1]
        ? ` (net ${netMatch[1]} distinct voices in the scrape window)`
        : ""
      return `- X authors: ${change.prior} → ${count}${netSuffix}`
    }
    case "price":
    case "liquidity":
    case "volume":
    case "fdv":
      return `- ${change.label}: ${change.prior} → ${change.current}${ratioSuffix(change.prior, change.current)}`
    default:
      return `- ${change.label}: ${change.prior} → ${change.current}`
  }
}

function formatMaterialChangeFallbackSentence(change: MaterialChange): string {
  switch (change.reason) {
    case "security-flags":
      return formatSecurityFlagsFallback(change)
    case "x-engagement":
      return formatEngagementFallback(change)
    case "x-authors": {
      const netMatch = change.current.match(/\(net ([+-]?\d+)\)/u)
      if (netMatch?.[1]) {
        const net = Number(netMatch[1])
        if (net >= 50) return `New independent X voices appeared (${change.prior} → ${change.current.replace(/\s*\(net.*\)/u, "")}).`
        if (net <= -100) return `X author count dropped sharply (${change.prior} → ${change.current.replace(/\s*\(net.*\)/u, "")}).`
      }
      return `X author count moved (${change.prior} → ${change.current}).`
    }
    case "security-hard-fail":
      return `Security hard-fail triggered (${change.prior} → ${change.current}).`
    case "security-status":
      return `Security status changed (${change.prior} → ${change.current}).`
    case "price":
    case "liquidity":
    case "volume":
    case "fdv":
      return `${change.label} moved (${change.prior} → ${change.current}).`
    default:
      return `${change.label} moved (${change.prior} → ${change.current}).`
  }
}

export function renderWatchUpdateFactsOnly(args: Readonly<{
  chain: string
  tokenAddress: string
  symbolDisplay?: string
  observedAt: string
  changes: readonly MaterialChange[]
}>): string {
  const label = args.symbolDisplay
    ? `**${args.symbolDisplay}** (${args.chain}:${args.tokenAddress})`
    : `**${args.chain}:${args.tokenAddress}**`
  const sentences = args.changes.map(formatMaterialChangeFallbackSentence)
  return [label, "", ...sentences].join("\n")
}

/** @deprecated use renderWatchUpdateFactsOnly */
export const renderWatchUpdate = renderWatchUpdateFactsOnly
