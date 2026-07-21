import { isGenericChainSymbol } from "./narrative-tickers.js"
import { isValidSolanaAddress, isValidEvmAddress } from "./address.js"

/**
 * Known native / wrapped gas tokens that must never burn research enqueue slots.
 * Compared case-insensitively. Symbol checks reuse GENERIC_CHAIN_SYMBOLS.
 */
const NATIVE_WRAP_MINTS = new Set([
  // Solana wrapped SOL
  "so11111111111111111111111111111111111111112",
  // EVM native sentinel + common wraps
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH ethereum
  "0x4200000000000000000000000000000000000006", // WETH base / optimism
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB bsc
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH arbitrum
])

export function isNativeOrWrapMint(
  tokenAddress: string,
  symbol?: string,
): boolean {
  if (symbol && isGenericChainSymbol(symbol)) return true
  const addr = tokenAddress.trim().toLowerCase()
  if (!addr) return false
  if (NATIVE_WRAP_MINTS.has(addr)) return true
  return false
}

/** Infer solana from base58-32 when Fomo omits/unknowns networkId; never guess EVM chain. */
export function inferChainFromTokenAddress(tokenAddress: string): string | undefined {
  const trimmed = tokenAddress.trim()
  if (!trimmed) return undefined
  if (isValidSolanaAddress(trimmed)) return "solana"
  if (isValidEvmAddress(trimmed)) return undefined
  return undefined
}
