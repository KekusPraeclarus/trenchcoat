import { getChain, type ChainEntry } from "./chains.js"
import {
  assertChainAddress,
  normalizeEvmAddress,
  validateChainAddress,
} from "./address.js"
import type { CanonicalIdentity } from "../contracts/schemas.js"

export type ResolveCandidate = Readonly<{
  chain: string
  tokenAddress: string
  pairAddress: string
  symbolDisplay: string
  liquidityUsd: number
  volume24hUsd: number
}>

export type ResolveResult =
  | Readonly<{ status: "resolved"; identity: CanonicalIdentity }>
  | Readonly<{ status: "ambiguous"; shortlist: CanonicalIdentity[] }>
  | Readonly<{ status: "unsupported-chain"; chain: string }>
  | Readonly<{ status: "empty" }>

export type ResolveOptions = Readonly<{
  /** When set, exact symbol matches (case-insensitive) outrank partial/name hits */
  expectedSymbol?: string
}>

/** Top must dominate runner-up by this factor when symbols collide (docs: ≥5×) */
const DOMINANCE_RATIO = 5
/** Below this 24h volume, deep liquidity alone is treated as an idle/clone signal */
const IDLE_VOLUME_USD = 10
/** Keep plausible exact-ticker rivals visible for operator choice */
const CREDIBLE_RELATIVE_FLOOR = 0.05

function toIdentity(
  candidate: ResolveCandidate,
  resolution: CanonicalIdentity["resolution"],
): CanonicalIdentity {
  const chain = getChain(candidate.chain)
  if (!chain) throw new Error(`Unknown chain ${candidate.chain}`)
  assertChainAddress(chain.addressFormat, candidate.tokenAddress)
  assertChainAddress(chain.addressFormat, candidate.pairAddress)
  const tokenAddress = chain.addressFormat === "evm"
    ? normalizeEvmAddress(candidate.tokenAddress)
    : candidate.tokenAddress
  const pairAddress = chain.addressFormat === "evm"
    ? normalizeEvmAddress(candidate.pairAddress)
    : candidate.pairAddress
  return {
    chain: candidate.chain as CanonicalIdentity["chain"],
    tokenAddress,
    pairAddress,
    symbolDisplay: candidate.symbolDisplay.slice(0, 32),
    resolution,
  }
}

function tokenKey(c: ResolveCandidate): string {
  return `${c.chain}:${c.tokenAddress.toLowerCase()}`
}

export function candidateHasValidAddresses(candidate: ResolveCandidate): boolean {
  const chain = getChain(candidate.chain)
  if (!chain) return false
  return validateChainAddress(chain.addressFormat, candidate.tokenAddress)
    && validateChainAddress(chain.addressFormat, candidate.pairAddress)
}

/** Drop DexScreener synthetic pairs (`:bpool`, 64-byte pool ids, etc.) */
export function filterValidAddressCandidates(
  candidates: readonly ResolveCandidate[],
): ResolveCandidate[] {
  return candidates.filter(candidateHasValidAddresses)
}

/** One row per (chain, token): deepest valid pool, volume summed across pools */
export function collapseToBestPoolPerToken(
  candidates: readonly ResolveCandidate[],
): ResolveCandidate[] {
  const best = new Map<string, ResolveCandidate>()
  for (const c of candidates) {
    const key = tokenKey(c)
    const prev = best.get(key)
    if (!prev) {
      best.set(key, c)
      continue
    }
    const deeper = c.liquidityUsd > prev.liquidityUsd
      || (c.liquidityUsd === prev.liquidityUsd && c.volume24hUsd > prev.volume24hUsd)
    best.set(key, {
      ...(deeper ? c : prev),
      volume24hUsd: prev.volume24hUsd + c.volume24hUsd,
    })
  }
  return [...best.values()]
}

export function credibilityScore(c: ResolveCandidate): number {
  // Idle high-liq clones (dust volume) must not outrank active markets
  if (c.volume24hUsd < IDLE_VOLUME_USD) {
    return c.liquidityUsd * 0.05 + c.volume24hUsd
  }
  return c.liquidityUsd + 0.35 * c.volume24hUsd
}

function rankCandidates(candidates: readonly ResolveCandidate[]): ResolveCandidate[] {
  return [...candidates].sort((a, b) => {
    const score = credibilityScore(b) - credibilityScore(a)
    if (score !== 0) return score
    const liq = b.liquidityUsd - a.liquidityUsd
    if (liq !== 0) return liq
    return b.volume24hUsd - a.volume24hUsd
  })
}

function preferExactSymbol(
  candidates: readonly ResolveCandidate[],
  expectedSymbol?: string,
): ResolveCandidate[] {
  if (!expectedSymbol) return [...candidates]
  const want = expectedSymbol.trim().toLowerCase()
  if (!want) return [...candidates]
  const exact = candidates.filter((c) => c.symbolDisplay.trim().toLowerCase() === want)
  return exact.length > 0 ? exact : [...candidates]
}

function clearlyDominates(top: ResolveCandidate, second: ResolveCandidate): boolean {
  const topScore = credibilityScore(top)
  const secondScore = Math.max(credibilityScore(second), 1)
  if (topScore / secondScore >= DOMINANCE_RATIO) return true
  if (top.liquidityUsd / Math.max(second.liquidityUsd, 1) >= DOMINANCE_RATIO) {
    // Liq-only dominance does not count when top is idle and second is active
    if (top.volume24hUsd < IDLE_VOLUME_USD && second.volume24hUsd >= IDLE_VOLUME_USD) {
      return false
    }
    return true
  }
  if (top.volume24hUsd / Math.max(second.volume24hUsd, 1) >= DOMINANCE_RATIO) return true
  return false
}

/**
 * Deterministic ticker/CA binding across supported chains.
 * Collapses multi-pool tokens, prefers exact symbol matches, ranks by
 * liquidity+volume credibility. Same-symbol near-ties stay ambiguous unless
 * liquidity, volume, or combined score dominates by ≥5×.
 */
export function resolveFromCandidates(
  candidates: readonly ResolveCandidate[],
  options: ResolveOptions = {},
): ResolveResult {
  const usable = filterValidAddressCandidates(candidates)
  if (usable.length === 0) return { status: "empty" }

  // Registry membership is required (address filter). Missing scanners stay
  // resolvable for research / Discord watch; main track still needs isTrackableChain.
  for (const c of usable) {
    if (!getChain(c.chain)) {
      return { status: "unsupported-chain", chain: c.chain }
    }
  }

  const collapsed = collapseToBestPoolPerToken(usable)
  const focused = preferExactSymbol(collapsed, options.expectedSymbol)
  const ranked = rankCandidates(focused)

  const top = ranked[0]!
  if (options.expectedSymbol) {
    const topScore = Math.max(credibilityScore(top), 1)
    const credible = ranked.filter(
      (candidate) => credibilityScore(candidate) / topScore >= CREDIBLE_RELATIVE_FLOOR,
    )
    if (credible.length > 1) {
      return {
        status: "ambiguous",
        shortlist: credible.slice(0, 5).map((c) => toIdentity(c, "ambiguous")),
      }
    }
  }

  const second = ranked[1]
  if (second) {
    const sameSymbol = top.symbolDisplay.toLowerCase() === second.symbolDisplay.toLowerCase()
    const differentToken = tokenKey(top) !== tokenKey(second)
    if (sameSymbol && differentToken && !clearlyDominates(top, second)) {
      return {
        status: "ambiguous",
        shortlist: ranked.slice(0, 5).map((c) => toIdentity(c, "ambiguous")),
      }
    }
  }

  return { status: "resolved", identity: toIdentity(top, "resolved") }
}

export function validateModelPick(
  shortlist: readonly CanonicalIdentity[],
  pickId: string | null,
): CanonicalIdentity | undefined {
  if (!pickId) return undefined
  return shortlist.find(
    (item) => `${item.chain}:${item.tokenAddress}` === pickId,
  )
}

export function requireTrackable(chain: ChainEntry | undefined): asserts chain is ChainEntry {
  if (!chain?.securityScanner) {
    throw new Error("Chain is not trackable")
  }
}
