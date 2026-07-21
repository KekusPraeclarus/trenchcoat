import { gatedFetchWithRetry, readJsonBody } from "../../lib/http.js"
import type { FetchLike } from "../market/geckoterminal.js"
import { keccak_256 } from "@noble/hashes/sha3"

export type InfuraClientOptions = Readonly<{
  apiKey: string
  network: "mainnet" | "base"
  fetcher?: FetchLike
}>

/**
 * Infura Core (free) throughput is 500 credits/second
 * (https://docs.metamask.io/services/get-started/pricing/).
 * eth_getLogs is our heaviest common wallet-scan method at 255 credits
 * (https://docs.metamask.io/services/get-started/pricing/credit-cost/).
 * Budget 80% of Core throughput so bursts / clock skew do not trip 429.
 */
export const INFURA_CORE_CREDITS_PER_SECOND = 500
export const INFURA_ETH_GET_LOGS_CREDITS = 255
export const INFURA_ETH_GET_BLOCK_BY_NUMBER_CREDITS = 80
export const INFURA_THROUGHPUT_BUDGET_CREDITS_PER_SECOND = Math.floor(
  INFURA_CORE_CREDITS_PER_SECOND * 0.8,
)
/** Serial pause sized for eth_getLogs under the budgeted throughput */
export const INFURA_MIN_INTERVAL_MS = Math.ceil(
  (INFURA_ETH_GET_LOGS_CREDITS / INFURA_THROUGHPUT_BUDGET_CREDITS_PER_SECOND) * 1_000,
)

const INFURA_CREDIT_COST: Readonly<Record<string, number>> = Object.freeze({
  eth_getLogs: INFURA_ETH_GET_LOGS_CREDITS,
  eth_getBlockByNumber: INFURA_ETH_GET_BLOCK_BY_NUMBER_CREDITS,
  eth_blockNumber: 80,
  eth_call: 80,
  eth_getBalance: 80,
  eth_getTransactionReceipt: 80,
  eth_getTransactionByHash: 80,
  eth_getCode: 80,
})

const TRANSFER_TOPIC = `0x${Buffer.from(keccak_256(new TextEncoder().encode("Transfer(address,address,uint256)"))).toString("hex")}`

function rpcUrl(opts: InfuraClientOptions): string {
  if (opts.network === "base") {
    return `https://base-mainnet.infura.io/v3/${opts.apiKey}`
  }
  return `https://mainnet.infura.io/v3/${opts.apiKey}`
}

export function infuraCreditCost(method: string): number {
  return INFURA_CREDIT_COST[method] ?? INFURA_ETH_GET_LOGS_CREDITS
}

export async function ethCall(
  opts: InfuraClientOptions,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const fetcher = opts.fetcher ?? fetch
  const response = await gatedFetchWithRetry(fetcher, rpcUrl(opts), {
    host: "infura.io",
    // One in-flight grant at a time; pacing comes from minIntervalMs + credit cost
    capacity: INFURA_ETH_GET_LOGS_CREDITS,
    refillPerSecond: INFURA_THROUGHPUT_BUDGET_CREDITS_PER_SECOND,
    minIntervalMs: INFURA_MIN_INTERVAL_MS,
    cost: infuraCreditCost(method),
    timeoutMs: 20_000,
    maxAttempts: 4,
    retryAfterCapSeconds: 30,
  }, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  if (!response.ok) throw new Error(`Infura HTTP ${response.status}`)
  const body = await readJsonBody(response) as { result?: unknown; error?: { message?: string } }
  if (body.error) throw new Error(body.error.message ?? "infura error")
  return body.result
}

export async function getFinalizedBlockNumber(opts: InfuraClientOptions): Promise<number> {
  const hex = await ethCall(opts, "eth_getBlockByNumber", ["finalized", false]) as {
    number?: string
  } | null
  if (!hex?.number) throw new Error("No finalized block")
  return Number.parseInt(hex.number, 16)
}

export async function getTransferLogs(
  opts: InfuraClientOptions,
  args: Readonly<{ fromBlock: number; toBlock: number; token?: string }>,
): Promise<Array<{
  removed?: boolean
  topics: string[]
  data: string
  transactionHash: string
  address?: string
  blockNumber?: string
  logIndex?: string
}>> {
  const result = await ethCall(opts, "eth_getLogs", [{
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
    logIndex?: string
  }>) ?? []
}

export function decodeErc20Transfer(log: Readonly<{
  topics: string[]
  data: string
  removed?: boolean
}>): { from: string; to: string; value: bigint; removed: boolean } | undefined {
  if (log.topics.length < 3) return undefined
  const from = `0x${log.topics[1]!.slice(26)}`
  const to = `0x${log.topics[2]!.slice(26)}`
  const value = BigInt(log.data)
  return { from, to, value, removed: Boolean(log.removed) }
}
