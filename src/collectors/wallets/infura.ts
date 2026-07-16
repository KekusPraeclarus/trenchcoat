import { gatedFetch, readJsonBody } from "../../lib/http.js"
import type { FetchLike } from "../market/geckoterminal.js"
import { keccak_256 } from "@noble/hashes/sha3"

export type InfuraClientOptions = Readonly<{
  apiKey: string
  network: "mainnet" | "base"
  fetcher?: FetchLike
}>

const TRANSFER_TOPIC = `0x${Buffer.from(keccak_256(new TextEncoder().encode("Transfer(address,address,uint256)"))).toString("hex")}`

function rpcUrl(opts: InfuraClientOptions): string {
  if (opts.network === "base") {
    return `https://base-mainnet.infura.io/v3/${opts.apiKey}`
  }
  return `https://mainnet.infura.io/v3/${opts.apiKey}`
}

export async function ethCall(
  opts: InfuraClientOptions,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const fetcher = opts.fetcher ?? fetch
  const response = await gatedFetch(fetcher, rpcUrl(opts), {
    host: "infura.io",
    capacity: 30,
    refillPerSecond: 0.5,
    timeoutMs: 20_000,
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
): Promise<Array<{ removed?: boolean; topics: string[]; data: string; transactionHash: string }>> {
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
