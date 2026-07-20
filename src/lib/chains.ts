export type ChainFamily = "evm" | "solana" | "other"
export type AddressFormat = "evm" | "base58-32"
export type SecurityScanner =
  | Readonly<{ kind: "goplus"; chainId: string }>
  | Readonly<{ kind: "rugcheck" }>

export type ChainEntry = Readonly<{
  slug: string
  display: string
  family: ChainFamily
  geckoterminalNetwork: string
  dexscreenerChainId: string
  securityScanner?: SecurityScanner
  nativeBenchmark: string
  addressFormat: AddressFormat
  walletTracking: "helius" | "infura" | "robinhood-public" | "unsupported"
  evmChainId?: number
}>

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/u
const BASE58_ALPHABET = /^[1-9A-HJ-NP-Za-km-z]+$/u

export const CHAIN_REGISTRY: ReadonlyArray<ChainEntry> = Object.freeze([
  {
    slug: "solana",
    display: "Solana",
    family: "solana",
    geckoterminalNetwork: "solana",
    dexscreenerChainId: "solana",
    securityScanner: { kind: "rugcheck" },
    nativeBenchmark: "solana:sol",
    addressFormat: "base58-32",
    walletTracking: "helius",
  },
  {
    slug: "ethereum",
    display: "Ethereum",
    family: "evm",
    geckoterminalNetwork: "eth",
    dexscreenerChainId: "ethereum",
    securityScanner: { kind: "goplus", chainId: "1" },
    nativeBenchmark: "ethereum:eth",
    addressFormat: "evm",
    walletTracking: "infura",
    evmChainId: 1,
  },
  {
    slug: "base",
    display: "Base",
    family: "evm",
    geckoterminalNetwork: "base",
    dexscreenerChainId: "base",
    securityScanner: { kind: "goplus", chainId: "8453" },
    nativeBenchmark: "ethereum:eth",
    addressFormat: "evm",
    walletTracking: "infura",
    evmChainId: 8453,
  },
  {
    slug: "bsc",
    display: "BNB Smart Chain",
    family: "evm",
    geckoterminalNetwork: "bsc",
    dexscreenerChainId: "bsc",
    securityScanner: { kind: "goplus", chainId: "56" },
    nativeBenchmark: "bsc:bnb",
    addressFormat: "evm",
    walletTracking: "unsupported",
    evmChainId: 56,
  },
  {
    slug: "robinhood",
    display: "Robinhood Chain",
    family: "evm",
    geckoterminalNetwork: "robinhood",
    dexscreenerChainId: "robinhood",
    // GoPlus 4663 verified at preflight; absent => token/wallet gate fail-closed
    securityScanner: { kind: "goplus", chainId: "4663" },
    nativeBenchmark: "ethereum:eth",
    addressFormat: "evm",
    walletTracking: "robinhood-public",
    evmChainId: 4663,
  },
  {
    slug: "plasma",
    display: "Plasma",
    family: "evm",
    geckoterminalNetwork: "plasma",
    dexscreenerChainId: "plasma",
    // GoPlus 9745 verified at preflight 2026-07-20
    securityScanner: { kind: "goplus", chainId: "9745" },
    nativeBenchmark: "plasma:xpl",
    addressFormat: "evm",
    walletTracking: "unsupported",
    evmChainId: 9745,
  },
  {
    slug: "hyperliquid",
    display: "Hyperliquid",
    family: "evm",
    // DexScreener/Gecko use hyperevm for HyperEVM AMM pools (not HyperCore spot)
    geckoterminalNetwork: "hyperevm",
    dexscreenerChainId: "hyperevm",
    // GoPlus has no HyperEVM/999 coverage yet — research + Discord watch OK; main track blocked
    nativeBenchmark: "hyperevm:hype",
    addressFormat: "evm",
    walletTracking: "unsupported",
    evmChainId: 999,
  },
])

export function getChain(slug: string): ChainEntry | undefined {
  return CHAIN_REGISTRY.find((entry) => entry.slug === slug)
}

/** Map DexScreener/Gecko chain ids onto our canonical slug (`eth` → ethereum, `hyperevm` → hyperliquid). */
export function chainSlugFromProviderId(providerChainId: string): string | undefined {
  if (providerChainId === "eth") return "ethereum"
  if (getChain(providerChainId)) return providerChainId
  return CHAIN_REGISTRY.find((entry) => entry.dexscreenerChainId === providerChainId)?.slug
    ?? CHAIN_REGISTRY.find((entry) => entry.geckoterminalNetwork === providerChainId)?.slug
}

/** Accept user/provider aliases (`hyperevm`, `hl`) as canonical registry slugs. */
export function normalizeChainSlug(raw: string): string | undefined {
  const lower = raw.toLowerCase()
  if (lower === "hyperevm" || lower === "hl") return "hyperliquid"
  if (lower === "sol") return "solana"
  if (lower === "eth") return "ethereum"
  if (lower === "bnb") return "bsc"
  if (lower === "hood") return "robinhood"
  return getChain(lower)?.slug ?? chainSlugFromProviderId(lower)
}

export function isTrackableChain(slug: string): boolean {
  const chain = getChain(slug)
  return Boolean(chain?.securityScanner)
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
