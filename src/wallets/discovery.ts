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

export type OperatorNominatedWallet = Readonly<{
  chain: string
  address: string
  note?: string
}>

export function addOperatorNominatedCandidates(
  file: WalletsFile,
  entries: readonly OperatorNominatedWallet[],
  seenAt: string,
): Readonly<{
  file: WalletsFile
  added: number
  addedWalletIds: string[]
  skippedExisting: number
  skippedExcluded: number
  skippedInvalid: number
}> {
  const seen = new Set<string>()
  let added = 0
  const addedWalletIds: string[] = []
  let skippedExisting = 0
  let skippedExcluded = 0
  let skippedInvalid = 0
  const byId = new Map(file.wallets.map((wallet) => [wallet.walletId, wallet]))

  for (const entry of entries) {
    const chain = getChain(entry.chain)
    if (!chain || chain.walletTracking === "unsupported") {
      skippedInvalid += 1
      continue
    }
    let address: string
    try {
      address = normalizeWalletAddress(entry.chain, entry.address)
    } catch {
      skippedInvalid += 1
      continue
    }
    const walletId = walletIdFor(entry.chain, address)
    if (seen.has(walletId)) {
      throw new Error(`Duplicate wallet nomination ${walletId}`)
    }
    seen.add(walletId)

    const existing = byId.get(walletId)
    if (existing) {
      if (existing.status === "excluded") skippedExcluded += 1
      else skippedExisting += 1
      continue
    }

    byId.set(walletId, {
      schema: 1,
      walletId,
      chain: entry.chain as WalletRecord["chain"],
      address,
      status: "candidate",
      discoveredFrom: "operator-nomination",
      addedAt: seenAt,
      updatedAt: seenAt,
      hardExcluded: false,
      ...(entry.note?.trim() ? { operatorReason: entry.note.trim() } : {}),
    })
    added += 1
    addedWalletIds.push(walletId)
  }

  return {
    file: {
      ...file,
      wallets: [...byId.values()].sort((a, b) => a.walletId.localeCompare(b.walletId)),
    },
    added,
    addedWalletIds,
    skippedExisting,
    skippedExcluded,
    skippedInvalid,
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
