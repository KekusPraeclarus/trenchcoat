import { sha256Json } from "../lib/canonical-json.js"
import { getChain } from "../lib/chains.js"
import { normalizeWalletAddress, walletIdFor } from "./seed.js"
import type {
  WalletDiscoveryOrigin,
  WalletRecord,
  WalletsFile,
} from "../contracts/schemas.js"

export type WalletDiscoverySighting = Readonly<{
  chain: string
  address: string
  origin: WalletDiscoveryOrigin
  tokenAddress?: string
}>

export function registerWalletCandidates(
  file: WalletsFile,
  sightings: readonly WalletDiscoverySighting[],
  seenAt: string,
): WalletsFile {
  const byId = new Map(file.wallets.map((wallet) => [wallet.walletId, wallet]))
  for (const sighting of sightings) {
    const chain = getChain(sighting.chain)
    if (!chain || chain.walletTracking === "unsupported") continue
    let address: string
    try {
      address = normalizeWalletAddress(sighting.chain, sighting.address)
    } catch {
      continue
    }
    const walletId = walletIdFor(sighting.chain, address)
    const existing = byId.get(walletId)
    if (existing) {
      if (existing.status === "excluded") continue
      byId.set(walletId, { ...existing, updatedAt: seenAt })
      continue
    }
    const record: WalletRecord = {
      schema: 1,
      walletId,
      chain: sighting.chain as WalletRecord["chain"],
      address,
      status: "candidate",
      discoveredFrom: sighting.origin,
      addedAt: seenAt,
      updatedAt: seenAt,
      hardExcluded: false,
    }
    byId.set(walletId, record)
  }
  return {
    ...file,
    wallets: [...byId.values()].sort((a, b) => a.walletId.localeCompare(b.walletId)),
  }
}

export function discoveryEvidenceHash(sighting: WalletDiscoverySighting, seenAt: string): `sha256:${string}` {
  return sha256Json({
    kind: "wallet-discovery",
    chain: sighting.chain,
    address: sighting.address,
    origin: sighting.origin,
    tokenAddress: sighting.tokenAddress ?? null,
    seenAt,
  })
}
