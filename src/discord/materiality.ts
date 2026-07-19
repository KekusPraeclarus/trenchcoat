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

function setChanged(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size !== sb.size) return true
  for (const x of sa) if (!sb.has(x)) return true
  return false
}

function doubledOrHalved(prior: number, current: number): boolean {
  return (pctChange(prior, current) ?? 0) >= DOUBLE_OR_HALF_MIN
}

export function detectMaterialChanges(
  baseline: DiscordObservation,
  current: DiscordObservation,
): MaterialChange[] {
  const out: MaterialChange[] = []

  if (
    baseline.securityStatus !== current.securityStatus
    && (baseline.securityStatus != null || current.securityStatus != null)
  ) {
    out.push({
      reason: "security-status",
      label: "Security status",
      prior: baseline.securityStatus ?? "unknown",
      current: current.securityStatus ?? "unknown",
    })
  }

  if (current.securityStatus === "hard-fail" && baseline.securityStatus !== "hard-fail") {
    out.push({
      reason: "security-hard-fail",
      label: "Security hard-fail",
      prior: baseline.securityStatus ?? "unknown",
      current: current.securityStatus ?? "hard-fail",
    })
  }

  if (setChanged(baseline.securityFlags, current.securityFlags)) {
    out.push({
      reason: "security-flags",
      label: "Security flags",
      prior: baseline.securityFlags.join(", ") || "none",
      current: current.securityFlags.join(", ") || "none",
    })
  }

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
  const lines = [
    `${label}`,
    `Scan: ${args.observedAt.slice(0, 19)}Z`,
    "",
    ...args.changes.map((c) => `- ${c.label}: ${c.prior} → ${c.current}`),
  ]
  return lines.join("\n")
}

/** @deprecated use renderWatchUpdateFactsOnly */
export const renderWatchUpdate = renderWatchUpdateFactsOnly
