import type { FetchLike } from "../market/geckoterminal.js"
import {
  getSignaturesForAddress,
  getTransaction,
  getAccountInfo,
  type HeliusClientOptions,
} from "./helius.js"
import { isZeroAddress, classifySolanaAccount } from "../../wallets/exclusions.js"
import type { WalletProviderAction } from "../../wallets/providers.js"

export type SolanaQuoteAssets = Readonly<{
  acceptNative: boolean
  allowlist: readonly string[]
}>

export type SolanaBuyerExtraction = Readonly<{
  buyers: readonly string[]
  actions: readonly WalletProviderAction[]
  /** Oldest signature in this page window — use as `before` for deeper history */
  nextBefore?: string
  /** Newest signature observed — tip for forward scans */
  tipSignature?: string
  raw: unknown
}>

function allowlistSet(quote: SolanaQuoteAssets): Set<string> {
  return new Set(quote.allowlist.map((a) => a.toLowerCase()))
}

function accountKeys(tx: object): string[] {
  const message = Reflect.get(tx, "transaction") as Record<string, unknown> | undefined
  const msg = message && typeof message === "object"
    ? Reflect.get(message, "message") as Record<string, unknown> | undefined
    : undefined
  const keys = msg ? Reflect.get(msg, "accountKeys") : undefined
  if (!Array.isArray(keys)) return []
  return keys.map((k) => {
    if (typeof k === "string") return k
    if (k && typeof k === "object") {
      const pubkey = Reflect.get(k, "pubkey")
      return typeof pubkey === "string" ? pubkey : ""
    }
    return ""
  }).filter(Boolean)
}

function signerFromTx(tx: object): string | undefined {
  const keys = accountKeys(tx)
  return keys[0]
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

function nativeLamports(tx: object, owner: string): { pre: bigint; post: bigint } {
  const meta = Reflect.get(tx, "meta") as Record<string, unknown> | undefined
  const keys = accountKeys(tx)
  const idx = keys.indexOf(owner)
  const preBalances = (meta?.["preBalances"] as unknown[] | undefined) ?? []
  const postBalances = (meta?.["postBalances"] as unknown[] | undefined) ?? []
  if (idx < 0) return { pre: 0n, post: 0n }
  return {
    pre: BigInt(String(preBalances[idx] ?? "0")),
    post: BigInt(String(postBalances[idx] ?? "0")),
  }
}

function quoteLoss(
  tx: object,
  owner: string,
  quote: SolanaQuoteAssets,
): { asset: string; amountRaw: string } | undefined {
  const allow = allowlistSet(quote)
  const meta = Reflect.get(tx, "meta") as Record<string, unknown> | undefined
  if (!meta) return undefined
  const pre = (meta["preTokenBalances"] as Array<Record<string, unknown>> | undefined) ?? []
  const post = (meta["postTokenBalances"] as Array<Record<string, unknown>> | undefined) ?? []
  const mints = new Set([
    ...pre.map((r) => String(r["mint"] ?? "").toLowerCase()),
    ...post.map((r) => String(r["mint"] ?? "").toLowerCase()),
  ])
  for (const mint of mints) {
    if (!mint || !allow.has(mint)) continue
    const preBal = balancesForMint(pre, mint).get(owner) ?? 0n
    // balancesForMint is case-sensitive on mint; re-scan with case-insensitive
    let preAmt = 0n
    let postAmt = 0n
    for (const row of pre) {
      if (String(row["mint"] ?? "").toLowerCase() !== mint) continue
      if (String(row["owner"] ?? "") !== owner) continue
      const ui = row["uiTokenAmount"] as Record<string, unknown> | undefined
      preAmt += BigInt(String(ui?.["amount"] ?? "0"))
    }
    for (const row of post) {
      if (String(row["mint"] ?? "").toLowerCase() !== mint) continue
      if (String(row["owner"] ?? "") !== owner) continue
      const ui = row["uiTokenAmount"] as Record<string, unknown> | undefined
      postAmt += BigInt(String(ui?.["amount"] ?? "0"))
    }
    void preBal
    if (postAmt < preAmt) {
      return { asset: mint, amountRaw: (preAmt - postAmt).toString() }
    }
  }
  if (quote.acceptNative) {
    const { pre: preLamports, post: postLamports } = nativeLamports(tx, owner)
    if (postLamports < preLamports) {
      return { asset: "native", amountRaw: (preLamports - postLamports).toString() }
    }
  }
  return undefined
}

/** Extract verified swap-buys: target mint gain + quote spend by signer/owner */
export function extractSolanaVerifiedBuysFromTransaction(
  tx: unknown,
  tokenMint: string,
  quote: SolanaQuoteAssets,
): WalletProviderAction[] {
  if (!tx || typeof tx !== "object") return []
  const meta = Reflect.get(tx, "meta") as Record<string, unknown> | undefined
  if (!meta || meta["err"]) return []
  const tr = Reflect.get(tx, "transaction")
  const sigs = tr && typeof tr === "object" ? Reflect.get(tr as object, "signatures") : undefined
  const sig = Array.isArray(sigs) && typeof sigs[0] === "string" ? sigs[0] : ""
  const blockTime = Reflect.get(tx, "blockTime")
  const slot = Reflect.get(tx, "slot")
  const ts = typeof blockTime === "number" ? blockTime * 1_000 : undefined
  const slotNum = typeof slot === "number" ? slot : 0
  if (ts === undefined || ts <= 0) return []

  const pre = (meta["preTokenBalances"] as Array<Record<string, unknown>> | undefined) ?? []
  const post = (meta["postTokenBalances"] as Array<Record<string, unknown>> | undefined) ?? []
  const preByOwner = balancesForMint(pre, tokenMint)
  const postByOwner = balancesForMint(post, tokenMint)
  const signer = signerFromTx(tx as object)
  const out: WalletProviderAction[] = []
  for (const [owner, postAmount] of postByOwner) {
    const preAmount = preByOwner.get(owner) ?? 0n
    if (postAmount <= preAmount) continue
    // Prefer signer match; allow owner === signer for ATA ownership
    if (signer && owner !== signer) continue
    const spent = quoteLoss(tx as object, owner, quote)
    if (!spent) continue
    const received = postAmount - preAmount
    out.push({
      walletAddress: owner,
      tokenAddress: tokenMint,
      timestamp: ts,
      finalized: true,
      priceable: true,
      providerEventId: `${sig || "unknown"}:${tokenMint}:${owner}`,
      blockOrSlot: slotNum,
      classification: "swap-buy",
      tokenReceivedRaw: received.toString(),
      quoteSpent: spent,
      ...(signer ? { txSender: signer } : {}),
    })
  }
  return out
}

/** @deprecated Prefer extractSolanaVerifiedBuysFromTransaction — balance-delta only, no quote proof */
export function extractSolanaBuyersFromTransaction(
  tx: unknown,
  tokenMint: string,
): string[] {
  return extractSolanaVerifiedBuysFromTransaction(tx, tokenMint, {
    acceptNative: true,
    allowlist: ["So11111111111111111111111111111111111111112"],
  }).map((a) => a.walletAddress)
}

export async function discoverSolanaEarlyBuyers(args: Readonly<{
  helius: HeliusClientOptions
  tokenMint: string
  before?: string
  until?: string
  maxPages?: number
  quoteAssets: SolanaQuoteAssets
}>): Promise<SolanaBuyerExtraction> {
  const maxPages = args.maxPages ?? 3
  const buyers = new Set<string>()
  const actions: WalletProviderAction[] = []
  let before = args.before
  let tipSignature: string | undefined
  let lastRaw: unknown = null
  for (let page = 0; page < maxPages; page += 1) {
    const signatures = await getSignaturesForAddress(
      args.helius,
      args.tokenMint,
      before,
      args.until,
    )
    lastRaw = signatures
    if (signatures.length === 0) break
    if (!tipSignature) tipSignature = signatures[0]?.signature
    for (const entry of signatures) {
      if (entry.err) continue
      const tx = await getTransaction(args.helius, entry.signature)
      lastRaw = tx
      for (const action of extractSolanaVerifiedBuysFromTransaction(tx, args.tokenMint, args.quoteAssets)) {
        buyers.add(action.walletAddress)
        actions.push(action)
      }
    }
    before = signatures[signatures.length - 1]?.signature
    if (signatures.length < 100) break
  }
  return {
    buyers: [...buyers].sort(),
    actions: actions.sort((a, b) => a.timestamp - b.timestamp || a.providerEventId.localeCompare(b.providerEventId)),
    ...(before ? { nextBefore: before } : {}),
    ...(tipSignature ? { tipSignature } : {}),
    raw: lastRaw,
  }
}

export async function listSolanaWalletActions(args: Readonly<{
  helius: HeliusClientOptions
  walletAddress: string
  fromTimestamp: number
  before?: string
  /** When set, only return activity newer than this tip signature (forward scan) */
  until?: string
  quoteAssets: SolanaQuoteAssets
  fetcher?: FetchLike
}>): Promise<Readonly<{
  actions: readonly WalletProviderAction[]
  nextBefore?: string
  tipSignature?: string
}>> {
  const helius = {
    ...args.helius,
    ...(args.fetcher ? { fetcher: args.fetcher } : {}),
  }
  const signatures = await getSignaturesForAddress(
    helius,
    args.walletAddress,
    args.before,
    args.until,
  )
  const tipSignature = signatures[0]?.signature
  const actions: WalletProviderAction[] = []
  const allow = allowlistSet(args.quoteAssets)
  for (const entry of signatures) {
    if (entry.err) continue
    const tx = await getTransaction(helius, entry.signature)
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
      if (allow.has(mint.toLowerCase())) continue
      for (const action of extractSolanaVerifiedBuysFromTransaction(tx, mint, args.quoteAssets)) {
        if (action.walletAddress !== args.walletAddress) continue
        actions.push(action)
      }
    }
  }
  const nextBefore = signatures.length > 0
    ? signatures[signatures.length - 1]?.signature
    : undefined
  return {
    actions: actions.sort((a, b) => a.timestamp - b.timestamp || a.providerEventId.localeCompare(b.providerEventId)),
    ...(nextBefore ? { nextBefore } : {}),
    ...(tipSignature ? { tipSignature } : {}),
  }
}

/** Returns true for executable program accounts. Incomplete RPC evidence returns undefined. */
export async function isSolanaExecutableAccount(
  helius: HeliusClientOptions,
  address: string,
): Promise<boolean | undefined> {
  try {
    const info = await getAccountInfo(helius, address)
    if (!info) return undefined
    const kind = classifySolanaAccount(info)
    if (kind === "unknown") return undefined
    return kind === "program"
  } catch {
    return undefined
  }
}
