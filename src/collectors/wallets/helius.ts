import { gatedFetch, readJsonBody } from "../../lib/http.js"
import type { FetchLike } from "../market/geckoterminal.js"

export type HeliusClientOptions = Readonly<{
  apiKey: string
  fetcher?: FetchLike
}>

export async function getSignaturesForAddress(
  opts: HeliusClientOptions,
  address: string,
  before?: string,
  until?: string,
): Promise<Array<{ signature: string; slot: number; err: unknown }>> {
  const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(opts.apiKey)}`
  const fetcher = opts.fetcher ?? fetch
  const response = await gatedFetch(fetcher, url, {
    host: "mainnet.helius-rpc.com",
    capacity: 40,
    refillPerSecond: 0.6,
    timeoutMs: 20_000,
  }, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [
        address,
        {
          commitment: "finalized",
          limit: 100,
          ...(before ? { before } : {}),
          ...(until ? { until } : {}),
        },
      ],
    }),
  })
  if (!response.ok) throw new Error(`Helius HTTP ${response.status}`)
  const body = await readJsonBody(response) as {
    result?: Array<{ signature: string; slot: number; err: unknown }>
  }
  return body.result ?? []
}

export async function getTransaction(
  opts: HeliusClientOptions,
  signature: string,
): Promise<unknown> {
  const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(opts.apiKey)}`
  const fetcher = opts.fetcher ?? fetch
  const response = await gatedFetch(fetcher, url, {
    host: "mainnet.helius-rpc.com",
    capacity: 40,
    refillPerSecond: 0.6,
    timeoutMs: 20_000,
  }, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 }],
    }),
  })
  if (!response.ok) throw new Error(`Helius HTTP ${response.status}`)
  const body = await readJsonBody(response) as { result?: unknown }
  return body.result
}

export async function getAccountInfo(
  opts: HeliusClientOptions,
  address: string,
): Promise<Readonly<{ executable: boolean; owner: string }> | null> {
  const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(opts.apiKey)}`
  const fetcher = opts.fetcher ?? fetch
  const response = await gatedFetch(fetcher, url, {
    host: "mainnet.helius-rpc.com",
    capacity: 40,
    refillPerSecond: 0.6,
    timeoutMs: 20_000,
  }, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [address, { commitment: "finalized", encoding: "base64" }],
    }),
  })
  if (!response.ok) throw new Error(`Helius HTTP ${response.status}`)
  const body = await readJsonBody(response) as {
    result?: { value?: { executable?: boolean; owner?: string } | null }
  }
  const value = body.result?.value
  if (!value || typeof value.executable !== "boolean" || typeof value.owner !== "string") {
    return null
  }
  return { executable: value.executable, owner: value.owner }
}
