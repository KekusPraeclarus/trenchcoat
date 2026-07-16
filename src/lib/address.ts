import { keccak_256 } from "@noble/hashes/sha3"
import bs58 from "bs58"
import type { AddressFormat } from "./chains.js"

const EVM = /^0x[0-9a-fA-F]{40}$/u

function toChecksumAddress(address: string): string {
  const lower = address.slice(2).toLowerCase()
  const hash = keccak_256(new TextEncoder().encode(lower))
  let out = "0x"
  for (let i = 0; i < lower.length; i += 1) {
    const nibble = hash[i >> 1]!
    const byte = i % 2 === 0 ? nibble >> 4 : nibble & 0x0f
    out += byte >= 8 ? lower[i]!.toUpperCase() : lower[i]
  }
  return out
}

export function isValidEvmAddress(address: string): boolean {
  if (!EVM.test(address)) return false
  if (address === address.toLowerCase() || address === address.toUpperCase()) return true
  return toChecksumAddress(address) === address
}

export function normalizeEvmAddress(address: string): string {
  if (!EVM.test(address)) throw new TypeError("Invalid EVM address")
  return toChecksumAddress(address)
}

export function isValidSolanaAddress(address: string): boolean {
  try {
    const bytes = bs58.decode(address)
    return bytes.length === 32
  } catch {
    return false
  }
}

export function validateChainAddress(format: AddressFormat, address: string): boolean {
  if (format === "evm") return isValidEvmAddress(address)
  return isValidSolanaAddress(address)
}

export function assertChainAddress(format: AddressFormat, address: string): void {
  if (!validateChainAddress(format, address)) {
    throw new TypeError(`Invalid ${format} address`)
  }
}
