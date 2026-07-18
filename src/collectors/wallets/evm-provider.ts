import { gatedFetch, readJsonBody } from "../../lib/http.js"
import type { FetchLike } from "../market/geckoterminal.js"
import { keccak_256 } from "@noble/hashes/sha3"
import { normalizeEvmAddress } from "../../lib/address.js"
import { isZeroAddress } from "../../wallets/exclusions.js"
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
  /** Robinhood public RPC throttle — capacity tokens */
  capacity?: number
  refillPerSecond?: number
}>

const TRANSFER_TOPIC = `0x${Buffer.from(keccak_256(new TextEncoder().encode("Transfer(address,address,uint256)"))).toString("hex")}`
const ROBINHOOD_RPC = "https://rpc.mainnet.chain.robinhood.com"

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
): Promise<Array<{
  removed?: boolean
  topics: string[]
  data: string
  transactionHash: string
  address?: string
  blockNumber?: string
}>> {
  if (opts.network !== "robinhood") {
    return getTransferLogs({
      apiKey: opts.apiKey!,
      network: opts.network,
      ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
    }, args)
  }
  const result = await evmRpcCall(opts, "eth_getLogs", [{
    fromBlock: `0x${args.fromBlock.toString(16)}`,
    toBlock: `0x${args.toBlock.toString(16)}`,
    topics: [TRANSFER_TOPIC],
    ...(args.token ? { address: args.token } : {}),
  }])
  return (result as Array<{
    removed?: boolean
    topics: string[]
    data: string
    transactionHash: string
    address?: string
    blockNumber?: string
  }>) ?? []
}

export type EvmBuyerExtraction = Readonly<{
  buyers: readonly string[]
  nextFromBlock: number
  raw: unknown
}>

/** Early buyers = Transfer recipients excluding zero-address mints and self-transfers. */
export async function discoverEvmEarlyBuyers(args: Readonly<{
  client: EvmClientOptions
  tokenAddress: string
  fromBlock: number
  toBlock?: number
  maxBlocks?: number
}>): Promise<EvmBuyerExtraction> {
  const finalized = args.toBlock ?? await getEvmFinalizedBlock(args.client)
  const maxBlocks = args.maxBlocks ?? 2_000
  const toBlock = Math.min(finalized, args.fromBlock + maxBlocks)
  if (toBlock < args.fromBlock) {
    return { buyers: [], nextFromBlock: args.fromBlock, raw: null }
  }
  const logs = await getEvmTransferLogs(args.client, {
    fromBlock: args.fromBlock,
    toBlock,
    token: args.tokenAddress,
  })
  const buyers = new Set<string>()
  for (const log of logs) {
    if (log.removed) continue
    const decoded = decodeErc20Transfer(log)
    if (!decoded || decoded.removed) continue
    if (isZeroAddress(decoded.from) || isZeroAddress(decoded.to)) continue
    if (decoded.from.toLowerCase() === decoded.to.toLowerCase()) continue
    try {
      buyers.add(normalizeEvmAddress(decoded.to))
    } catch {
      continue
    }
  }
  return {
    buyers: [...buyers].sort(),
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
}>): Promise<Readonly<{
  actions: readonly WalletProviderAction[]
  nextFromBlock: number
}>> {
  const finalized = args.toBlock ?? await getEvmFinalizedBlock(args.client)
  const maxBlocks = args.maxBlocks ?? 2_000
  const toBlock = Math.min(finalized, args.fromBlock + maxBlocks)
  if (toBlock < args.fromBlock) {
    return { actions: [], nextFromBlock: args.fromBlock }
  }
  const logs = await getEvmTransferLogs(args.client, {
    fromBlock: args.fromBlock,
    toBlock,
    ...(args.tokenAddress ? { token: args.tokenAddress } : {}),
  })
  const wallet = normalizeEvmAddress(args.walletAddress).toLowerCase()
  const actions: WalletProviderAction[] = []
  for (const log of logs) {
    const decoded = decodeErc20Transfer(log)
    if (!decoded) continue
    if (decoded.to.toLowerCase() !== wallet) continue
    if (isZeroAddress(decoded.from)) continue
    const token = log.address ? normalizeEvmAddress(log.address) : args.tokenAddress
    if (!token) continue
    const blockNumber = log.blockNumber
      ? Number.parseInt(log.blockNumber, 16)
      : toBlock
    actions.push({
      walletAddress: normalizeEvmAddress(args.walletAddress),
      tokenAddress: token,
      timestamp: blockNumber,
      finalized: !decoded.removed,
      removed: decoded.removed,
      priceable: true,
    })
  }
  return { actions, nextFromBlock: toBlock + 1 }
}

export function networkForChain(slug: string): EvmRpcNetwork {
  if (slug === "base") return "base"
  if (slug === "robinhood") return "robinhood"
  if (slug === "ethereum") return "mainnet"
  throw new TypeError(`No EVM RPC network for ${slug}`)
}
