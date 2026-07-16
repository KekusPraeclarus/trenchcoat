import { getChain, isTrackableChain, type ChainEntry } from "./chains.js"
import { assertChainAddress } from "./address.js"
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

function toIdentity(
  candidate: ResolveCandidate,
  resolution: CanonicalIdentity["resolution"],
): CanonicalIdentity {
  const chain = getChain(candidate.chain)
  if (!chain) throw new Error(`Unknown chain ${candidate.chain}`)
  assertChainAddress(chain.addressFormat, candidate.tokenAddress)
  assertChainAddress(chain.addressFormat, candidate.pairAddress)
  return {
    chain: candidate.chain as CanonicalIdentity["chain"],
    tokenAddress: candidate.tokenAddress,
    pairAddress: candidate.pairAddress,
    symbolDisplay: candidate.symbolDisplay.slice(0, 32),
    resolution,
  }
}

export function resolveFromCandidates(
  candidates: readonly ResolveCandidate[],
): ResolveResult {
  if (candidates.length === 0) return { status: "empty" }

  for (const c of candidates) {
    if (!isTrackableChain(c.chain)) {
      return { status: "unsupported-chain", chain: c.chain }
    }
  }

  const ranked = [...candidates].sort((a, b) => {
    const liq = b.liquidityUsd - a.liquidityUsd
    if (liq !== 0) return liq
    return b.volume24hUsd - a.volume24hUsd
  })

  const top = ranked[0]!
  const second = ranked[1]
  if (
    second
    && top.symbolDisplay.toLowerCase() === second.symbolDisplay.toLowerCase()
    && top.liquidityUsd > 0
    && second.liquidityUsd / top.liquidityUsd > 0.7
  ) {
    return {
      status: "ambiguous",
      shortlist: ranked.slice(0, 5).map((c) => toIdentity(c, "ambiguous")),
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
