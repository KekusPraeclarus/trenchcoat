import type { FetchLike } from "../market/geckoterminal.js"
import {
  getSignaturesForAddress,
  getTransaction,
  type HeliusClientOptions,
} from "./helius.js"
import { isZeroAddress } from "../../wallets/exclusions.js"
import type { WalletProviderAction } from "../../wallets/providers.js"

export type SolanaBuyerExtraction = Readonly<{
  buyers: readonly string[]
  nextBefore?: string
  raw: unknown
}>

/** Extract early buyers from token-balance increases in a finalized Helius tx. */
export function extractSolanaBuyersFromTransaction(
  tx: unknown,
  tokenMint: string,
): string[] {
  if (!tx || typeof tx !== "object") return []
  const meta = Reflect.get(tx, "meta") as Record<string, unknown> | undefined
  if (!meta || meta["err"]) return []
  const pre = (meta["preTokenBalances"] as Array<Record<string, unknown>> | undefined) ?? []
  const post = (meta["postTokenBalances"] as Array<Record<string, unknown>> | undefined) ?? []
  const preByOwner = balancesForMint(pre, tokenMint)
  const postByOwner = balancesForMint(post, tokenMint)
  const buyers: string[] = []
  for (const [owner, postAmount] of postByOwner) {
    const preAmount = preByOwner.get(owner) ?? 0n
    if (postAmount > preAmount && owner) {
      buyers.push(owner)
    }
  }
  return [...new Set(buyers)]
}

export async function discoverSolanaEarlyBuyers(args: Readonly<{
  helius: HeliusClientOptions
  tokenMint: string
  before?: string
  maxPages?: number
}>): Promise<SolanaBuyerExtraction> {
  const maxPages = args.maxPages ?? 3
  const buyers = new Set<string>()
  let before = args.before
  let lastRaw: unknown = null
  for (let page = 0; page < maxPages; page += 1) {
    const signatures = await getSignaturesForAddress(args.helius, args.tokenMint, before)
    lastRaw = signatures
    if (signatures.length === 0) break
    for (const entry of signatures) {
      if (entry.err) continue
      const tx = await getTransaction(args.helius, entry.signature)
      lastRaw = tx
      for (const buyer of extractSolanaBuyersFromTransaction(tx, args.tokenMint)) {
        buyers.add(buyer)
      }
    }
    before = signatures[signatures.length - 1]?.signature
    if (signatures.length < 100) break
  }
  return {
    buyers: [...buyers].sort(),
    ...(before ? { nextBefore: before } : {}),
    raw: lastRaw,
  }
}

export async function listSolanaWalletActions(args: Readonly<{
  helius: HeliusClientOptions
  walletAddress: string
  fromTimestamp: number
  before?: string
  fetcher?: FetchLike
}>): Promise<Readonly<{
  actions: readonly WalletProviderAction[]
  nextBefore?: string
}>> {
  const signatures = await getSignaturesForAddress(
    { ...args.helius, ...(args.fetcher ? { fetcher: args.fetcher } : {}) },
    args.walletAddress,
    args.before,
  )
  const actions: WalletProviderAction[] = []
  for (const entry of signatures) {
    if (entry.err) continue
    const tx = await getTransaction(args.helius, entry.signature)
    if (!tx || typeof tx !== "object") continue
    const blockTime = Reflect.get(tx, "blockTime")
    const ts = typeof blockTime === "number" ? blockTime * 1_000 : undefined
    if (ts === undefined || ts < args.fromTimestamp) continue
    const meta = Reflect.get(tx, "meta") as Record<string, unknown> | undefined
    if (!meta || meta["err"]) continue
    const post = (meta["postTokenBalances"] as Array<Record<string, unknown>> | undefined) ?? []
    const pre = (meta["preTokenBalances"] as Array<Record<string, unknown>> | undefined) ?? []
    const mints = new Set([
      ...post.map((row) => String(row["mint"] ?? "")),
      ...pre.map((row) => String(row["mint"] ?? "")),
    ])
    for (const mint of mints) {
      if (!mint) continue
      const preBal = balancesForMint(pre, mint).get(args.walletAddress) ?? 0n
      const postBal = balancesForMint(post, mint).get(args.walletAddress) ?? 0n
      if (postBal <= preBal) continue
      actions.push({
        walletAddress: args.walletAddress,
        tokenAddress: mint,
        timestamp: ts,
        finalized: true,
        priceable: true,
      })
    }
  }
  const nextBefore = signatures.length > 0
    ? signatures[signatures.length - 1]?.signature
    : undefined
  return {
    actions,
    ...(nextBefore ? { nextBefore } : {}),
  }
}

function balancesForMint(
  rows: readonly Record<string, unknown>[],
  mint: string,
): Map<string, bigint> {
  const out = new Map<string, bigint>()
  for (const row of rows) {
    if (String(row["mint"] ?? "") !== mint) continue
    const owner = String(row["owner"] ?? "")
    if (!owner || isZeroAddress(owner)) continue
    const ui = row["uiTokenAmount"] as Record<string, unknown> | undefined
    const amount = BigInt(String(ui?.["amount"] ?? "0"))
    out.set(owner, (out.get(owner) ?? 0n) + amount)
  }
  return out
}
