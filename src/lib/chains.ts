import {
  GENERATED_ALIAS_TO_SLUG,
  GENERATED_CHAIN_REGISTRY,
  GENERATED_CHAIN_SLUGS,
  type GeneratedChainSlug,
} from "./chains.generated.js"
import type { ChainCapabilities } from "./chain-manifest.js"

export type ChainFamily = "evm" | "solana" | "other"
export type AddressFormat = "evm" | "base58-32"
export type SecurityScanner =
  | Readonly<{ kind: "goplus"; chainId: string }>
  | Readonly<{ kind: "rugcheck" }>

export type ChainEntry = Readonly<{
  slug: string
  display: string
  family: ChainFamily
  aliases: readonly string[]
  geckoterminalNetwork: string
  dexscreenerChainId: string
  securityScanner?: SecurityScanner
  nativeBenchmark: string
  addressFormat: AddressFormat
  walletTracking: "helius" | "infura" | "robinhood-public" | "unsupported"
  evmChainId?: number
  capabilities: ChainCapabilities
}>

export type ChainSlug = GeneratedChainSlug

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/u
const BASE58_ALPHABET = /^[1-9A-HJ-NP-Za-km-z]+$/u
/** Bounded slug for unknown-chain intake (integration lane) */
export const CHAIN_SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/u
export const CHAIN_CA_GENERIC_RE =
  /^(?:<@!?&?\d+>\s*)?(?:(?:research|deep\s+research|look\s*into|investigate|analyse|analyze|check\s+out|deep[\s-]?dive)\s+)?(?:`)?([a-z][a-z0-9-]{1,31}):([A-Za-z0-9]{32,128})(?:`)?$/iu

export const CHAIN_REGISTRY: ReadonlyArray<ChainEntry> =
  GENERATED_CHAIN_REGISTRY as unknown as ReadonlyArray<ChainEntry>
export const CHAIN_SLUGS: readonly ChainSlug[] = GENERATED_CHAIN_SLUGS

export function getChain(slug: string): ChainEntry | undefined {
  return CHAIN_REGISTRY.find((entry) => entry.slug === slug)
}

/** Map DexScreener/Gecko chain ids onto our canonical slug. */
export function chainSlugFromProviderId(providerChainId: string): string | undefined {
  if (getChain(providerChainId)) return providerChainId
  return CHAIN_REGISTRY.find((entry) => entry.dexscreenerChainId === providerChainId)?.slug
    ?? CHAIN_REGISTRY.find((entry) => entry.geckoterminalNetwork === providerChainId)?.slug
}

/** Accept user/provider aliases as canonical registry slugs. */
export function normalizeChainSlug(raw: string): string | undefined {
  const lower = raw.toLowerCase()
  const fromAlias = GENERATED_ALIAS_TO_SLUG[lower]
  if (fromAlias) return fromAlias
  return getChain(lower)?.slug ?? chainSlugFromProviderId(lower)
}

export function isKnownChainSlug(slug: string): boolean {
  return Boolean(normalizeChainSlug(slug))
}

export function isTrackableChain(slug: string): boolean {
  const chain = getChain(slug)
  return Boolean(chain?.securityScanner && chain.capabilities.mainTrack)
}

export function validateAddress(format: AddressFormat, address: string): boolean {
  if (format === "evm") return EVM_ADDRESS.test(address)
  return BASE58_ALPHABET.test(address) && address.length >= 32 && address.length <= 44
}

export function assertAddress(format: AddressFormat, address: string): void {
  if (!validateAddress(format, address)) {
    throw new TypeError(`Invalid ${format} address`)
  }
}

export function parseChainCa(
  text: string,
): { chainRaw: string; token: string } | undefined {
  const match = text.trim().match(CHAIN_CA_GENERIC_RE)
  if (!match?.[1] || !match[2]) return undefined
  return { chainRaw: match[1].toLowerCase(), token: match[2] }
}

export function knownChainSlugsAlternation(): string {
  const all = new Set<string>()
  for (const entry of CHAIN_REGISTRY) {
    all.add(entry.slug)
    for (const alias of entry.aliases) all.add(alias)
  }
  return [...all].sort((a, b) => b.length - a.length).join("|")
}
