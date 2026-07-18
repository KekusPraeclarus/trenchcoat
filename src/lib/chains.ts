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
])

export function getChain(slug: string): ChainEntry | undefined {
  return CHAIN_REGISTRY.find((entry) => entry.slug === slug)
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
