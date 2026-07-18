import { gatedFetch, readJsonBody } from "../../lib/http.js"
import type { FetchLike } from "../market/geckoterminal.js"
import type { SnapshotEnvelope } from "../../contracts/schemas.js"

const TAVILY_ROOT = "https://api.tavily.com"
const MAX_QUERY = 200
const MAX_RESULTS = 8
const SAFE_QUERY = /^[\x20-\x7E]+$/u

export type TavilySearchHit = Readonly<{
  title: string
  url: string
  description: string
}>

export type TavilySearchResult = Readonly<{
  query: string
  hits: readonly TavilySearchHit[]
}>

function stringField(value: unknown, max: number): string {
  if (typeof value !== "string") return ""
  return value.replace(/\s+/gu, " ").trim().slice(0, max)
}

export function parseTavilySearchResults(
  payload: unknown,
  query: string,
): TavilySearchResult {
  if (payload === null || typeof payload !== "object") {
    throw new TypeError("Tavily response must be an object")
  }
  const results = Reflect.get(payload, "results")
  if (!Array.isArray(results)) {
    return { query, hits: [] }
  }
  const hits: TavilySearchHit[] = []
  for (const raw of results.slice(0, MAX_RESULTS)) {
    if (raw === null || typeof raw !== "object") continue
    const title = stringField(Reflect.get(raw, "title"), 200)
    const url = stringField(Reflect.get(raw, "url"), 500)
    const description = stringField(
      Reflect.get(raw, "content") ?? Reflect.get(raw, "description"),
      1_000,
    )
    if (!title || !url.startsWith("https://")) continue
    hits.push({ title, url, description })
  }
  return { query, hits }
}

export async function searchTavilyWeb(args: Readonly<{
  fetcher: FetchLike
  apiKey: string
  query: string
  count?: number
}>): Promise<TavilySearchResult> {
  const query = args.query.trim()
  if (query.length < 1 || query.length > MAX_QUERY || !SAFE_QUERY.test(query)) {
    throw new TypeError("Tavily query must be 1-200 printable ASCII characters")
  }
  if (!args.apiKey.trim()) throw new TypeError("Tavily API key required")

  // Host builds the only allowed URL — never from model-supplied strings
  const url = new URL("/search", TAVILY_ROOT)
  const response = await gatedFetch(args.fetcher, url, {
    host: "api.tavily.com",
    capacity: 30,
    refillPerSecond: 0.5,
    maxBytes: 1_000_000,
    timeoutMs: 15_000,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.apiKey}`,
    },
  }, {
    method: "POST",
    body: JSON.stringify({
      query,
      max_results: Math.min(args.count ?? 5, MAX_RESULTS),
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    }),
  })
  if (!response.ok) {
    throw new Error(`Tavily search failed with HTTP ${response.status}`)
  }
  return parseTavilySearchResults(await readJsonBody(response, 1_000_000), query)
}

export function tavilyHitsToSnapshot(args: Readonly<{
  query: string
  hits: readonly TavilySearchHit[]
  fetchedAt: string
  runId: string
}>): SnapshotEnvelope {
  return {
    source: "tavily.web",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: args.hits.map((hit, index) => ({
      provenance: `${args.runId}:tavily:${index}`,
      text: `${hit.title}\n${hit.description}\nquery=${args.query}`,
      url: hit.url,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live" as const,
      dedupeKey: hit.url,
    })),
  }
}
