import { createHash } from "node:crypto"
import type { FomoDerivedSignal, FomoLeaderboardEntry, FomoTradeEvent, FomoTrendingObservation } from "./types.js"

function eventId(event: FomoTradeEvent): string {
  if (event.sourceId) return event.sourceId
  return createHash("sha256")
    .update([
      event.chain ?? "",
      event.tokenAddress ?? "",
      event.handle ?? "",
      event.action ?? "",
      event.eventAt,
    ].join("|"))
    .digest("hex")
    .slice(0, 24)
}

export function deriveConvergence(args: Readonly<{
  events: readonly FomoTradeEvent[]
  qualifiedHandles: ReadonlySet<string>
  windowMinutes: number
  minTraders: number
  observedAt: string
}>): FomoDerivedSignal[] {
  const buys = args.events.filter((event) => (
    event.action === "buy"
    && event.chain
    && event.tokenAddress
    && event.handle
    && args.qualifiedHandles.has(event.handle)
  ))
  const byToken = new Map<string, FomoTradeEvent[]>()
  for (const event of buys) {
    const key = `${event.chain}:${event.tokenAddress}`
    const list = byToken.get(key) ?? []
    list.push(event)
    byToken.set(key, list)
  }
  const out: FomoDerivedSignal[] = []
  const windowMs = args.windowMinutes * 60_000
  for (const [key, events] of byToken) {
    const sorted = [...events].sort((a, b) => Date.parse(a.eventAt) - Date.parse(b.eventAt))
    for (let i = 0; i < sorted.length; i += 1) {
      const start = Date.parse(sorted[i]!.eventAt)
      const windowEvents = sorted.filter((event) => {
        const ts = Date.parse(event.eventAt)
        return ts >= start && ts <= start + windowMs
      })
      const handles = [...new Set(windowEvents.map((event) => event.handle!).filter(Boolean))]
      if (handles.length < args.minTraders) continue
      const [chain, tokenAddress] = key.split(":") as [string, string]
      out.push({
        kind: "convergence",
        chain,
        tokenAddress,
        ...(windowEvents[0]?.symbol ? { symbol: windowEvents[0].symbol } : {}),
        handles,
        sourceEventIds: windowEvents.map(eventId),
        windowStart: new Date(start).toISOString(),
        windowEnd: new Date(start + windowMs).toISOString(),
        observedAt: args.observedAt,
      })
      break
    }
  }
  return out
}

export function derivePressure(args: Readonly<{
  events: readonly FomoTradeEvent[]
  qualifiedHandles: ReadonlySet<string>
  windowMinutes: number
  minTraders: number
  side: "buy" | "sell"
  observedAt: string
}>): FomoDerivedSignal[] {
  const filtered = args.events.filter((event) => (
    event.action === args.side
    && event.chain
    && event.tokenAddress
    && event.handle
    && args.qualifiedHandles.has(event.handle)
  ))
  const byToken = new Map<string, FomoTradeEvent[]>()
  for (const event of filtered) {
    const key = `${event.chain}:${event.tokenAddress}`
    const list = byToken.get(key) ?? []
    list.push(event)
    byToken.set(key, list)
  }
  const out: FomoDerivedSignal[] = []
  const windowMs = args.windowMinutes * 60_000
  for (const [key, events] of byToken) {
    const sorted = [...events].sort((a, b) => Date.parse(a.eventAt) - Date.parse(b.eventAt))
    for (let i = 0; i < sorted.length; i += 1) {
      const start = Date.parse(sorted[i]!.eventAt)
      const windowEvents = sorted.filter((event) => {
        const ts = Date.parse(event.eventAt)
        return ts >= start && ts <= start + windowMs
      })
      const handles = [...new Set(windowEvents.map((event) => event.handle!).filter(Boolean))]
      if (handles.length < args.minTraders) continue
      const usdSum = windowEvents.reduce((sum, event) => sum + (event.usdAmount ?? 0), 0)
      const [chain, tokenAddress] = key.split(":") as [string, string]
      out.push({
        kind: args.side === "buy" ? "buy-pressure" : "sell-pressure",
        chain,
        tokenAddress,
        ...(windowEvents[0]?.symbol ? { symbol: windowEvents[0].symbol } : {}),
        handles,
        sourceEventIds: windowEvents.map(eventId),
        windowStart: new Date(start).toISOString(),
        windowEnd: new Date(start + windowMs).toISOString(),
        observedAt: args.observedAt,
        ...(usdSum > 0 ? { usdSum } : {}),
      })
      break
    }
  }
  return out
}

export function trendingSignals(
  trending: readonly FomoTrendingObservation[],
  observedAt: string,
  limit = 10,
): FomoDerivedSignal[] {
  return trending
    .filter((item) => item.chain && item.tokenAddress)
    .slice(0, limit)
    .map((item) => ({
      kind: "trending" as const,
      chain: item.chain!,
      tokenAddress: item.tokenAddress!,
      ...(item.symbol ? { symbol: item.symbol } : {}),
      handles: [],
      sourceEventIds: [`trending:${item.rank}:${item.tokenAddress}`],
      windowStart: item.observedAt,
      windowEnd: item.observedAt,
      observedAt,
    }))
}

export function qualifiedHandleSet(
  leaderboard: readonly FomoLeaderboardEntry[],
): Set<string> {
  return new Set(leaderboard.map((entry) => entry.handle.toLowerCase()))
}

export function dedupeTradeEvents(events: readonly FomoTradeEvent[]): FomoTradeEvent[] {
  const seen = new Set<string>()
  const out: FomoTradeEvent[] = []
  for (const event of events) {
    const id = eventId(event)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(event)
  }
  return out
}
