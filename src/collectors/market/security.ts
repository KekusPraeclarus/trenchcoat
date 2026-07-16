import { gatedFetch, readJsonBody } from "../../lib/http.js"
import type { FetchLike } from "./geckoterminal.js"

export type SecurityVerdict = "pass" | "caution" | "fail" | "pending"

export type SecurityResult = Readonly<{
  verdict: SecurityVerdict
  reasons: readonly string[]
  rawHash?: `sha256:${string}`
}>

export async function goplusTokenSecurity(
  fetcher: FetchLike,
  chainId: string,
  tokenAddress: string,
  appKey?: string,
): Promise<SecurityResult> {
  const url = new URL(
    `https://api.gopluslabs.io/api/v1/token_security/${encodeURIComponent(chainId)}`,
  )
  url.searchParams.set("contract_addresses", tokenAddress)
  const headers: Record<string, string> = { accept: "application/json" }
  if (appKey) headers["Authorization"] = appKey
  const response = await gatedFetch(fetcher, url, {
    host: "api.gopluslabs.io",
    capacity: 30,
    refillPerSecond: 0.5,
    headers,
    timeoutMs: 15_000,
  })
  if (response.status === 429) return { verdict: "pending", reasons: ["goplus-429"] }
  if (!response.ok) return { verdict: "pending", reasons: [`goplus-http-${response.status}`] }
  const body = await readJsonBody(response) as {
    result?: Record<string, Record<string, string>>
  }
  const row = body.result?.[tokenAddress.toLowerCase()] ?? body.result?.[tokenAddress]
  if (!row) return { verdict: "pending", reasons: ["goplus-empty"] }
  const reasons: string[] = []
  if (row["is_honeypot"] === "1") reasons.push("honeypot")
  if (Number(row["sell_tax"] ?? 0) > 0.2) reasons.push("sell-tax")
  if (row["is_open_source"] === "0") reasons.push("not-open-source")
  if (row["is_mintable"] === "1") reasons.push("mintable")
  if (reasons.includes("honeypot")) return { verdict: "fail", reasons }
  if (reasons.length > 0) return { verdict: "caution", reasons }
  return { verdict: "pass", reasons: [] }
}

export async function rugcheckReport(
  fetcher: FetchLike,
  mint: string,
): Promise<SecurityResult> {
  const url = `https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report`
  const response = await gatedFetch(fetcher, url, {
    host: "api.rugcheck.xyz",
    capacity: 30,
    refillPerSecond: 0.5,
    headers: { accept: "application/json" },
    timeoutMs: 15_000,
  })
  if (response.status === 429) return { verdict: "pending", reasons: ["rugcheck-429"] }
  if (!response.ok) return { verdict: "pending", reasons: [`rugcheck-http-${response.status}`] }
  const body = await readJsonBody(response) as {
    score?: number
    risks?: Array<{ name?: string; level?: string }>
  }
  const reasons = (body.risks ?? [])
    .filter((r) => r.level === "danger" || r.level === "warn")
    .map((r) => r.name ?? "risk")
  if ((body.score ?? 0) < 1 && reasons.some((r) => /honeypot|rug/iu.test(r))) {
    return { verdict: "fail", reasons }
  }
  if (reasons.length > 0) return { verdict: "caution", reasons }
  return { verdict: "pass", reasons: [] }
}

export function marketQualityPreflight(args: Readonly<{
  liquidityUsd: number
  txns24h: number
  fdvUsd: number
  thresholds: Readonly<{
    liquidity_floor_usd: number
    txns_24h_min: number
    fdv_liquidity_max: number
  }>
}>): SecurityResult {
  const reasons: string[] = []
  if (args.liquidityUsd < args.thresholds.liquidity_floor_usd) reasons.push("low-liquidity")
  if (args.txns24h < args.thresholds.txns_24h_min) reasons.push("low-txns")
  if (
    args.liquidityUsd > 0
    && args.fdvUsd / args.liquidityUsd > args.thresholds.fdv_liquidity_max
  ) {
    reasons.push("fdv-liquidity")
  }
  if (reasons.length > 0) return { verdict: "fail", reasons }
  return { verdict: "pass", reasons: [] }
}
