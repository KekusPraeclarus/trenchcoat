import { gatedFetch, readJsonBody } from "../../lib/http.js"
import type { FetchLike } from "../market/geckoterminal.js"
import { keccak_256 } from "@noble/hashes/sha3"
import { normalizeEvmAddress } from "../../lib/address.js"
import { isZeroAddress, classifyEvmBytecode } from "../../wallets/exclusions.js"
import type { WalletProviderAction } from "../../wallets/providers.js"
import {
  decodeErc20Transfer,
  ethCall,
  getFinalizedBlockNumber,
  getTransferLogs,
  type InfuraClientOptions,
} from "./infura.js"

export type EvmRpcNetwork = "mainnet" | "base" | "robinhood"

export type EvmClientOptions = Readonly<{
  network: EvmRpcNetwork
  apiKey?: string
  fetcher?: FetchLike
  capacity?: number
  refillPerSecond?: number
}>

export type EvmQuoteAssets = Readonly<{
  acceptNative: boolean
  allowlist: readonly string[]
}>

const TRANSFER_TOPIC = `0x${Buffer.from(keccak_256(new TextEncoder().encode("Transfer(address,address,uint256)"))).toString("hex")}`
const ROBINHOOD_RPC = "https://rpc.mainnet.chain.robinhood.com"

type EvmLog = Readonly<{
  removed?: boolean
  topics: string[]
  data: string
  transactionHash: string
  address?: string
  blockNumber?: string
  logIndex?: string
}>

type CachedReceipt = Readonly<{
  status: "0x0" | "0x1" | string
  from: string
  to?: string | null
  logs: readonly EvmLog[]
}>

type CachedBlock = Readonly<{
  timestampMs: number
}>

export type EvmRunCache = {
  receipts: Map<string, CachedReceipt | null>
  blocks: Map<number, CachedBlock>
}

export function createEvmRunCache(): EvmRunCache {
  return { receipts: new Map(), blocks: new Map() }
}

function hostFor(network: EvmRpcNetwork): string {
  if (network === "robinhood") return "rpc.mainnet.chain.robinhood.com"
  return "infura.io"
}

function rpcUrl(opts: EvmClientOptions): string {
  if (opts.network === "robinhood") return ROBINHOOD_RPC
  if (!opts.apiKey) throw new Error(`Infura api key required for ${opts.network}`)
  if (opts.network === "base") return `https://base-mainnet.infura.io/v3/${opts.apiKey}`
  return `https://mainnet.infura.io/v3/${opts.apiKey}`
}

function allowlistSet(quote: EvmQuoteAssets): Set<string> {
  return new Set(quote.allowlist.map((a) => a.toLowerCase()))
}

export async function evmRpcCall(
  opts: EvmClientOptions,
  method: string,
  params: unknown[],
): Promise<unknown> {
  if (opts.network !== "robinhood") {
    const infura: InfuraClientOptions = {
      apiKey: opts.apiKey!,
      network: opts.network,
      ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
    }
    return ethCall(infura, method, params)
  }

  const fetcher = opts.fetcher ?? fetch
  const capacity = opts.capacity ?? 8
  const refillPerSecond = opts.refillPerSecond ?? 0.15
  const response = await gatedFetch(fetcher, rpcUrl(opts), {
    host: hostFor(opts.network),
    capacity,
    refillPerSecond,
    timeoutMs: 20_000,
  }, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      throw new Error(`Robinhood RPC fail-closed HTTP ${response.status}`)
    }
    throw new Error(`Robinhood RPC HTTP ${response.status}`)
  }
  const body = await readJsonBody(response) as { result?: unknown; error?: { message?: string } }
  if (body.error) throw new Error(body.error.message ?? "robinhood rpc error")
  return body.result
}

export async function getEvmFinalizedBlock(opts: EvmClientOptions): Promise<number> {
  if (opts.network !== "robinhood") {
    return getFinalizedBlockNumber({
      apiKey: opts.apiKey!,
      network: opts.network,
      ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
    })
  }
  const hex = await evmRpcCall(opts, "eth_getBlockByNumber", ["finalized", false]) as {
    number?: string
  } | null
  if (!hex?.number) throw new Error("No finalized block")
  return Number.parseInt(hex.number, 16)
}

export async function getEvmTransferLogs(
  opts: EvmClientOptions,
  args: Readonly<{ fromBlock: number; toBlock: number; token?: string }>,
): Promise<EvmLog[]> {
  if (opts.network !== "robinhood") {
    return getTransferLogs({
      apiKey: opts.apiKey!,
      network: opts.network,
      ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
    }, args) as Promise<EvmLog[]>
  }
  const result = await evmRpcCall(opts, "eth_getLogs", [{
    fromBlock: `0x${args.fromBlock.toString(16)}`,
    toBlock: `0x${args.toBlock.toString(16)}`,
    topics: [TRANSFER_TOPIC],
    ...(args.token ? { address: args.token } : {}),
  }])
  return (result as EvmLog[]) ?? []
}

async function getReceipt(
  opts: EvmClientOptions,
  txHash: string,
  cache: EvmRunCache,
): Promise<CachedReceipt | null> {
  const key = txHash.toLowerCase()
  if (cache.receipts.has(key)) return cache.receipts.get(key) ?? null
  const raw = await evmRpcCall(opts, "eth_getTransactionReceipt", [txHash]) as {
    status?: string
    from?: string
    to?: string | null
    logs?: EvmLog[]
  } | null
  if (!raw?.from || !raw.status) {
    cache.receipts.set(key, null)
    return null
  }
  const receipt: CachedReceipt = {
    status: raw.status,
    from: normalizeEvmAddress(raw.from),
    to: raw.to ?? null,
    logs: raw.logs ?? [],
  }
  cache.receipts.set(key, receipt)
  return receipt
}

async function getBlockTimestampMs(
  opts: EvmClientOptions,
  blockNumber: number,
  cache: EvmRunCache,
): Promise<number | undefined> {
  if (cache.blocks.has(blockNumber)) return cache.blocks.get(blockNumber)!.timestampMs
  const raw = await evmRpcCall(opts, "eth_getBlockByNumber", [
    `0x${blockNumber.toString(16)}`,
    false,
  ]) as { timestamp?: string } | null
  if (!raw?.timestamp) return undefined
  const timestampMs = Number.parseInt(raw.timestamp, 16) * 1_000
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return undefined
  cache.blocks.set(blockNumber, { timestampMs })
  return timestampMs
}

function quoteSpendEvidence(
  receipt: CachedReceipt,
  buyer: string,
  quote: EvmQuoteAssets,
): { asset: string; amountRaw: string } | undefined {
  const buyerLc = buyer.toLowerCase()
  const allow = allowlistSet(quote)
  for (const log of receipt.logs) {
    if (!log.address) continue
    const token = normalizeEvmAddress(log.address).toLowerCase()
    if (!allow.has(token)) continue
    const decoded = decodeErc20Transfer(log)
    if (!decoded || decoded.removed) continue
    if (decoded.from.toLowerCase() !== buyerLc) continue
    if (isZeroAddress(decoded.to)) continue
    if (decoded.value <= 0n) continue
    return { asset: normalizeEvmAddress(log.address), amountRaw: decoded.value.toString() }
  }
  return undefined
}

async function getNativeValueSpent(
  opts: EvmClientOptions,
  txHash: string,
  sender: string,
): Promise<bigint | undefined> {
  const tx = await evmRpcCall(opts, "eth_getTransactionByHash", [txHash]) as {
    from?: string
    value?: string
  } | null
  if (!tx?.from || !tx.value) return undefined
  if (normalizeEvmAddress(tx.from).toLowerCase() !== sender.toLowerCase()) return undefined
  return BigInt(tx.value)
}

function classifyVerifiedBuy(args: Readonly<{
  tokenAddress: string
  buyer: string
  receipt: CachedReceipt
  tokenLog: EvmLog
  decodedTo: string
  decodedFrom: string
  decodedValue: bigint
  quote: EvmQuoteAssets
  nativeSpent?: bigint
}>): WalletProviderAction | undefined {
  if (args.receipt.status !== "0x1") return undefined
  if (isZeroAddress(args.decodedFrom) || isZeroAddress(args.decodedTo)) return undefined
  if (args.decodedFrom.toLowerCase() === args.decodedTo.toLowerCase()) return undefined
  if (args.decodedValue <= 0n) return undefined
  const buyer = normalizeEvmAddress(args.buyer)
  if (args.decodedTo.toLowerCase() !== buyer.toLowerCase()) return undefined
  // Buyer must be the transaction sender for swap-buy classification
  if (args.receipt.from.toLowerCase() !== buyer.toLowerCase()) return undefined

  const quoteSpend = quoteSpendEvidence(args.receipt, buyer, args.quote)
  const nativeOk = args.quote.acceptNative && (args.nativeSpent ?? 0n) > 0n
  if (!quoteSpend && !nativeOk) return undefined

  const blockNumber = args.tokenLog.blockNumber
    ? Number.parseInt(args.tokenLog.blockNumber, 16)
    : NaN
  if (!Number.isFinite(blockNumber)) return undefined
  const logIndex = args.tokenLog.logIndex
    ? Number.parseInt(args.tokenLog.logIndex, 16)
    : 0
  return {
    walletAddress: buyer,
    tokenAddress: normalizeEvmAddress(args.tokenAddress),
    timestamp: 0, // filled by caller after block lookup
    finalized: !args.tokenLog.removed,
    removed: Boolean(args.tokenLog.removed),
    priceable: true,
    providerEventId: `${args.tokenLog.transactionHash}:${logIndex}`,
    blockOrSlot: blockNumber,
    classification: "swap-buy",
    tokenReceivedRaw: args.decodedValue.toString(),
    txSender: args.receipt.from,
    ...(quoteSpend
      ? { quoteSpent: quoteSpend }
      : nativeOk
        ? { quoteSpent: { asset: "native", amountRaw: String(args.nativeSpent) } }
        : {}),
  }
}

export type EvmBuyerExtraction = Readonly<{
  buyers: readonly string[]
  actions: readonly WalletProviderAction[]
  nextFromBlock: number
  raw: unknown
}>

/** Verified early buyers = swap-buy: target token received by tx sender + quote spend */
export async function discoverEvmEarlyBuyers(args: Readonly<{
  client: EvmClientOptions
  tokenAddress: string
  fromBlock: number
  toBlock?: number
  maxBlocks?: number
  quoteAssets: EvmQuoteAssets
  cache?: EvmRunCache
}>): Promise<EvmBuyerExtraction> {
  const cache = args.cache ?? createEvmRunCache()
  const finalized = args.toBlock ?? await getEvmFinalizedBlock(args.client)
  const maxBlocks = args.maxBlocks ?? 2_000
  const toBlock = Math.min(finalized, args.fromBlock + maxBlocks)
  if (toBlock < args.fromBlock) {
    return { buyers: [], actions: [], nextFromBlock: args.fromBlock, raw: null }
  }
  const logs = await getEvmTransferLogs(args.client, {
    fromBlock: args.fromBlock,
    toBlock,
    token: args.tokenAddress,
  })
  const actions: WalletProviderAction[] = []
  const buyers = new Set<string>()
  for (const log of logs) {
    if (log.removed) continue
    const decoded = decodeErc20Transfer(log)
    if (!decoded || decoded.removed) continue
    let buyer: string
    try {
      buyer = normalizeEvmAddress(decoded.to)
    } catch {
      continue
    }
    const receipt = await getReceipt(args.client, log.transactionHash, cache)
    if (!receipt) continue
    const nativeSpent = args.quoteAssets.acceptNative
      ? await getNativeValueSpent(args.client, log.transactionHash, receipt.from)
      : undefined
    const action = classifyVerifiedBuy({
      tokenAddress: args.tokenAddress,
      buyer,
      receipt,
      tokenLog: log,
      decodedTo: decoded.to,
      decodedFrom: decoded.from,
      decodedValue: decoded.value,
      quote: args.quoteAssets,
      ...(nativeSpent !== undefined ? { nativeSpent } : {}),
    })
    if (!action) continue
    const ts = await getBlockTimestampMs(args.client, action.blockOrSlot, cache)
    if (ts === undefined) continue
    const stamped = { ...action, timestamp: ts }
    actions.push(stamped)
    buyers.add(stamped.walletAddress)
  }
  return {
    buyers: [...buyers].sort(),
    actions: actions.sort((a, b) => a.timestamp - b.timestamp || a.providerEventId.localeCompare(b.providerEventId)),
    nextFromBlock: toBlock + 1,
    raw: logs,
  }
}

export async function listEvmWalletActions(args: Readonly<{
  client: EvmClientOptions
  walletAddress: string
  tokenAddress?: string
  fromBlock: number
  toBlock?: number
  maxBlocks?: number
  quoteAssets: EvmQuoteAssets
  cache?: EvmRunCache
}>): Promise<Readonly<{
  actions: readonly WalletProviderAction[]
  nextFromBlock: number
}>> {
  const cache = args.cache ?? createEvmRunCache()
  const finalized = args.toBlock ?? await getEvmFinalizedBlock(args.client)
  const maxBlocks = args.maxBlocks ?? 2_000
  const toBlock = Math.min(finalized, args.fromBlock + maxBlocks)
  if (toBlock < args.fromBlock) {
    return { actions: [], nextFromBlock: args.fromBlock }
  }
  const wallet = normalizeEvmAddress(args.walletAddress)
  const logs = await getEvmTransferLogs(args.client, {
    fromBlock: args.fromBlock,
    toBlock,
    ...(args.tokenAddress ? { token: args.tokenAddress } : {}),
  })
  const actions: WalletProviderAction[] = []
  for (const log of logs) {
    const decoded = decodeErc20Transfer(log)
    if (!decoded) continue
    if (decoded.to.toLowerCase() !== wallet.toLowerCase()) continue
    if (isZeroAddress(decoded.from)) continue
    const token = log.address ? normalizeEvmAddress(log.address) : args.tokenAddress
    if (!token) continue
    const receipt = await getReceipt(args.client, log.transactionHash, cache)
    if (!receipt) continue
    const nativeSpent = args.quoteAssets.acceptNative
      ? await getNativeValueSpent(args.client, log.transactionHash, receipt.from)
      : undefined
    const action = classifyVerifiedBuy({
      tokenAddress: token,
      buyer: wallet,
      receipt,
      tokenLog: log,
      decodedTo: decoded.to,
      decodedFrom: decoded.from,
      decodedValue: decoded.value,
      quote: args.quoteAssets,
      ...(nativeSpent !== undefined ? { nativeSpent } : {}),
    })
    if (!action) continue
    const ts = await getBlockTimestampMs(args.client, action.blockOrSlot, cache)
    if (ts === undefined) continue
    actions.push({ ...action, timestamp: ts })
  }
  return {
    actions: actions.sort((a, b) => a.timestamp - b.timestamp || a.providerEventId.localeCompare(b.providerEventId)),
    nextFromBlock: toBlock + 1,
  }
}

export function networkForChain(slug: string): EvmRpcNetwork {
  if (slug === "base") return "base"
  if (slug === "robinhood") return "robinhood"
  if (slug === "ethereum") return "mainnet"
  throw new TypeError(`No EVM RPC network for ${slug}`)
}

/** Returns true when eth_getCode is non-empty bytecode. Incomplete RPC evidence returns undefined. */
export async function isEvmContractAddress(
  opts: EvmClientOptions,
  address: string,
): Promise<boolean | undefined> {
  try {
    const code = await evmRpcCall(opts, "eth_getCode", [address, "finalized"]) as string | null
    const kind = classifyEvmBytecode(code)
    if (kind === "unknown") return undefined
    return kind === "contract"
  } catch {
    return undefined
  }
}
