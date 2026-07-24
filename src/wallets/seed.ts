import { z } from "zod"
import { getChain } from "../lib/chains.js"
import { assertChainAddress, normalizeEvmAddress } from "../lib/address.js"
import { sha256Json } from "../lib/canonical-json.js"
import {
  ChainSlugSchema,
  WalletsFileSchema,
  type WalletRecord,
  type WalletTransition,
  type WalletsFile,
} from "../contracts/schemas.js"
import { buildWalletTransition } from "./lifecycle.js"

export const OperatorWalletSeedEntrySchema = z.object({
  chain: ChainSlugSchema,
  address: z.string().min(32).max(128),
  note: z.string().min(1).max(280).optional(),
})
export type OperatorWalletSeedEntry = z.infer<typeof OperatorWalletSeedEntrySchema>

export const OperatorSeedFileSchema = z.object({
  schema: z.literal(1),
  watchlist: z.array(z.object({
    chain: ChainSlugSchema,
    token_address: z.string().min(32).max(128),
    thesis: z.string().min(1).max(500),
  })).max(500).default([]),
  sources: z.array(z.string().min(1).max(256)).max(5_000).default([]),
  wallets: z.array(OperatorWalletSeedEntrySchema).max(5_000).default([]),
})
export type OperatorSeedFile = z.infer<typeof OperatorSeedFileSchema>

export const OperatorCandidateFileSchema = z.object({
  schema: z.literal(1),
  wallets: z.array(OperatorWalletSeedEntrySchema).max(500).default([]),
})
export type OperatorCandidateFile = z.infer<typeof OperatorCandidateFileSchema>

export function normalizeWalletAddress(chain: string, address: string): string {
  const entry = getChain(chain)
  if (!entry) throw new TypeError(`Unknown chain ${chain}`)
  if (entry.walletTracking === "unsupported") {
    throw new TypeError(`Wallet tracking unsupported for chain ${chain}`)
  }
  assertChainAddress(entry.addressFormat, address)
  return entry.addressFormat === "evm" ? normalizeEvmAddress(address) : address
}

export function walletIdFor(chain: string, address: string): string {
  return `${chain}:${address}`
}

export function buildOperatorSeededWallet(
  entry: OperatorWalletSeedEntry,
  nowIso: string,
): WalletRecord {
  const address = normalizeWalletAddress(entry.chain, entry.address)
  return {
    schema: 1,
    walletId: walletIdFor(entry.chain, address),
    chain: entry.chain,
    address,
    status: "tracking-probation",
    discoveredFrom: "operator-seed",
    addedAt: nowIso,
    updatedAt: nowIso,
    hardExcluded: false,
    ...(entry.note ? { operatorReason: entry.note } : {}),
  }
}

export function seedWalletsFromOperatorList(args: Readonly<{
  entries: readonly OperatorWalletSeedEntry[]
  existing: WalletsFile
  nowIso: string
  runId: string
}>): Readonly<{
  file: WalletsFile
  transitions: WalletTransition[]
  added: number
}> {
  if (args.existing.wallets.length > 0) {
    throw new Error("wallets.json is not empty — refuse operator seed into existing wallet state")
  }
  if (args.entries.length === 0) {
    return {
      file: WalletsFileSchema.parse({
        schema: 1,
        wallets: [],
        transitions: [],
        pendingTransitionIds: [],
        cursors: [],
        exclusions: [],
      }),
      transitions: [],
      added: 0,
    }
  }

  const seen = new Set<string>()
  const wallets: WalletRecord[] = []
  const transitions: WalletTransition[] = []

  for (const entry of args.entries) {
    const wallet = buildOperatorSeededWallet(entry, args.nowIso)
    if (seen.has(wallet.walletId)) {
      throw new Error(`Duplicate wallet seed ${wallet.walletId}`)
    }
    seen.add(wallet.walletId)
    wallets.push(wallet)
    const evidenceHash = sha256Json({
      kind: "operator-seed",
      walletId: wallet.walletId,
      chain: wallet.chain,
      address: wallet.address,
    })
    transitions.push(buildWalletTransition({
      wallet,
      action: "added",
      reasonCode: "operator-seed",
      reasonLine: entry.note?.trim() || "operator seed",
      occurredAt: args.nowIso,
      runId: args.runId,
      evidenceHash,
    }))
  }

  return {
    file: WalletsFileSchema.parse({
      schema: 1,
      wallets,
      transitions,
      pendingTransitionIds: [],
      cursors: [],
      exclusions: [],
    }),
    transitions,
    added: wallets.length,
  }
}
