import { getChain, validateAddress } from "../../lib/chains.js"
import { gatedFetch, readJsonBody } from "../../lib/http.js"
import type { FetchLike } from "./geckoterminal.js"
import type { MarketPair } from "./providers.js"

export type SecurityFlag =
  | "honeypot"
  | "cannot-sell-all"
  | "mintable"
  | "owner-can-change-balance"
  | "selfdestruct"
  | "sell-tax"
  | "low-lp-lock"
  | "mint-authority"
  | "freeze-authority"
  | "top-holder-concentration"
  | "proxy-contract"
  | "buy-tax"
  | "cooldown"
  | "anti-whale"
  | "blacklist"
  | "unverified-source"

export type SecurityResult = Readonly<{
  status: "pass" | "hard-fail" | "pending" | "unsupported-chain"
  hardFail: boolean
  flags: readonly SecurityFlag[]
  provider?: "goplus" | "rugcheck"
  rawHash?: `sha256:${string}`
  reason?: string
}>

export type MarketQualityResult = Readonly<{
  status: "pass" | "fail"
  reasons: readonly ("liquidity" | "transactions" | "one-sided-flow" | "fdv-liquidity" | "liquidity-delta")[]
}>

export type SecurityThresholds = Readonly<{
  sellTaxMax: number
  lpLockedMin: number
  holderTop10Max: number
  liquidityFloorUsd: number
  txns24hMin: number
  fdvLiquidityMax: number
  liquidityDeltaMin: number
}>

export const DEFAULT_SECURITY_THRESHOLDS: SecurityThresholds = {
  sellTaxMax: 0.20,
  lpLockedMin: 0.80,
  holderTop10Max: 0.50,
  liquidityFloorUsd: 30_000,
  txns24hMin: 150,
  fdvLiquidityMax: 100,
  liquidityDeltaMin: -0.30,
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}

function enabled(value: unknown): boolean {
  return value === "1" || value === 1 || value === true
}

function ratio(value: unknown): number | undefined {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  if (!Number.isFinite(numberValue) || numberValue < 0) return undefined
  return numberValue > 1 ? numberValue / 100 : numberValue
}

function lockFraction(holders: unknown): number | undefined {
  if (!Array.isArray(holders) || holders.length === 0) return undefined
  let total = 0
  let locked = 0
  for (const holder of holders) {
    const value = record(holder, "LP holder")
    const percent = ratio(value["percent"]) ?? ratio(value["percentage"])
    if (percent === undefined) continue
    total += percent
    const address = typeof value["address"] === "string" ? value["address"].toLowerCase() : ""
    if (enabled(value["is_locked"]) || enabled(value["is_burned"]) || address === "0x000000000000000000000000000000000000dead") locked += percent
  }
  return total === 0 ? undefined : locked / total
}

export function mapGoPlus(payload: unknown, thresholds = DEFAULT_SECURITY_THRESHOLDS): SecurityResult {
  const root = record(payload, "GoPlus response")
  const rawResult = record(root["result"], "GoPlus result")
  const result = Object.values(rawResult).find((value) => value !== null && typeof value === "object" && !Array.isArray(value))
  const fields = result === undefined ? rawResult : record(result, "GoPlus token result")
  const flags: SecurityFlag[] = []
  if (enabled(fields["is_honeypot"])) flags.push("honeypot")
  if (enabled(fields["cannot_sell_all"])) flags.push("cannot-sell-all")
  if (enabled(fields["is_mintable"])) flags.push("mintable")
  if (enabled(fields["owner_change_balance"])) flags.push("owner-can-change-balance")
  if (enabled(fields["selfdestruct"])) flags.push("selfdestruct")
  const sellTax = ratio(fields["sell_tax"])
  const buyTax = ratio(fields["buy_tax"])
  const fraction = lockFraction(fields["lp_holders"])
  if (sellTax !== undefined && sellTax >= thresholds.sellTaxMax) flags.push("sell-tax")
  if (fraction !== undefined && fraction < thresholds.lpLockedMin) flags.push("low-lp-lock")
  if (enabled(fields["is_proxy"])) flags.push("proxy-contract")
  if (buyTax !== undefined && buyTax >= 0.05) flags.push("buy-tax")
  if (enabled(fields["trading_cooldown"])) flags.push("cooldown")
  if (enabled(fields["anti_whale_modifiable"])) flags.push("anti-whale")
  if (enabled(fields["is_blacklisted"])) flags.push("blacklist")
  if (enabled(fields["is_open_source"]) === false) flags.push("unverified-source")
  // mintable and low-lp-lock are caution-only: surfaced, never hardFail alone
  const hardFail = flags.some((flag) => [
    "honeypot",
    "cannot-sell-all",
    "owner-can-change-balance",
    "selfdestruct",
    "sell-tax",
  ].includes(flag))
  return { status: hardFail ? "hard-fail" : "pass", hardFail, flags, provider: "goplus" }
}

export function mapRugCheck(payload: unknown, thresholds = DEFAULT_SECURITY_THRESHOLDS): SecurityResult {
  const result = record(payload, "RugCheck response")
  const flags: SecurityFlag[] = []
  if (result["mintAuthority"] !== null && result["mintAuthority"] !== undefined) flags.push("mint-authority")
  if (result["freezeAuthority"] !== null && result["freezeAuthority"] !== undefined) flags.push("freeze-authority")
  const lp = ratio(result["lpLockedPct"]) ?? ratio(result["lpLockedPercent"])
  const concentration = ratio(result["top10HolderPercent"]) ?? ratio(result["top10HoldersPercent"])
  if (lp !== undefined && lp < thresholds.lpLockedMin) flags.push("low-lp-lock")
  if (concentration !== undefined && concentration > thresholds.holderTop10Max) flags.push("top-holder-concentration")
  // mint-authority and low-lp-lock are caution-only on Solana
  const hardFail = flags.some((flag) => [
    "freeze-authority",
    "top-holder-concentration",
  ].includes(flag))
  return { status: hardFail ? "hard-fail" : "pass", hardFail, flags, provider: "rugcheck" }
}

/** Active mint flags that need model classification before track is allowed */
export const ACTIVE_MINT_FLAGS = ["mintable", "mint-authority"] as const

export function hasActiveMintFlag(flags: readonly string[]): boolean {
  return flags.some((flag) => (
    flag === "mintable" || flag === "mint-authority"
  ))
}

/**
 * Host-side contextual mint rule: mintable memecoins stay blocked.
 * Non-meme classifications may track when the scanner only flagged mint risk.
 * Missing classification fails closed when mint is active.
 */
export function mintTrackBlockReason(
  flags: readonly string[],
  projectClassification: string | undefined,
): "mintable-memecoin" | "mintable-missing-classification" | undefined {
  if (!hasActiveMintFlag(flags)) return undefined
  if (projectClassification === undefined) return "mintable-missing-classification"
  if (projectClassification === "memecoin") return "mintable-memecoin"
  return undefined
}

export function preflightMarketQuality(
  pair: MarketPair,
  previousLiquidityUsd: number | undefined,
  thresholds = DEFAULT_SECURITY_THRESHOLDS,
): MarketQualityResult {
  const reasons: MarketQualityResult["reasons"][number][] = []
  const liquidity = pair.liquidityUsd
  if (liquidity === undefined || liquidity < thresholds.liquidityFloorUsd) reasons.push("liquidity")
  const txns = pair.buys24h + pair.sells24h
  if (txns < thresholds.txns24hMin) reasons.push("transactions")
  if (txns === 0 || pair.buys24h / txns < 0.25 || pair.sells24h / txns < 0.25) reasons.push("one-sided-flow")
  if (liquidity === undefined || pair.fdv === undefined || pair.fdv / liquidity > thresholds.fdvLiquidityMax) reasons.push("fdv-liquidity")
  if (previousLiquidityUsd !== undefined && previousLiquidityUsd > 0 && liquidity !== undefined && (liquidity - previousLiquidityUsd) / previousLiquidityUsd <= thresholds.liquidityDeltaMin) reasons.push("liquidity-delta")
  return { status: reasons.length === 0 ? "pass" : "fail", reasons }
}

export async function fetchSecurityGate(
  fetcher: FetchLike,
  chainSlug: string,
  tokenAddress: string,
  thresholds = DEFAULT_SECURITY_THRESHOLDS,
): Promise<SecurityResult> {
  const chain = getChain(chainSlug)
  if (!chain?.securityScanner || !validateAddress(chain.addressFormat, tokenAddress)) {
    return { status: "unsupported-chain", hardFail: false, flags: [], reason: "Unsupported chain or invalid token address" }
  }
  try {
    if (chain.securityScanner.kind === "goplus") {
      const url = new URL(`https://api.gopluslabs.io/api/v1/token_security/${chain.securityScanner.chainId}`)
      url.searchParams.set("contract_addresses", tokenAddress)
      const response = await gatedFetch(fetcher, url, { host: "api.gopluslabs.io", capacity: 20, refillPerSecond: 20 / 60 })
      if (!response.ok) return { status: "pending", hardFail: false, flags: [], provider: "goplus", reason: `HTTP ${response.status}` }
      const payload = await readJsonBody(response)
      return mapGoPlus(payload, thresholds)
    }
    const response = await gatedFetch(fetcher, `https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(tokenAddress)}/report`, { host: "api.rugcheck.xyz", capacity: 20, refillPerSecond: 20 / 60 })
    if (!response.ok) return { status: "pending", hardFail: false, flags: [], provider: "rugcheck", reason: `HTTP ${response.status}` }
    return mapRugCheck(await readJsonBody(response), thresholds)
  } catch (error) {
    return { status: "pending", hardFail: false, flags: [], reason: error instanceof Error ? error.message : "Scanner request failed" }
  }
}
