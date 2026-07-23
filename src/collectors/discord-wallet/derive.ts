import type { DiscordWalletSignal, TxEvent } from "./types.js"

function normalizeActor(actor: string): string {
  return actor.trim().toLowerCase()
}

function normalizeCa(tokenContract: string): string {
  const trimmed = tokenContract.trim()
  if (/^0x[a-fA-F0-9]{40}$/u.test(trimmed)) return trimmed.toLowerCase()
  return trimmed
}

function withinWindow(receivedAt: string, nowIso: string, windowMinutes: number): boolean {
  const ts = Date.parse(receivedAt)
  const now = Date.parse(nowIso)
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return false
  return now - ts <= windowMinutes * 60_000 && now - ts >= 0
}

function dedupeByActorCaSide(
  events: readonly TxEvent[],
  ttlMinutes: number,
): TxEvent[] {
  const ttlMs = ttlMinutes * 60_000
  const kept: TxEvent[] = []
  const seen = new Map<string, number>()
  const sorted = [...events].sort(
    (a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt),
  )
  for (const event of sorted) {
    if (!event.tokenContract) continue
    const key = `${normalizeActor(event.actor)}|${normalizeCa(event.tokenContract)}|${event.side}`
    const ts = Date.parse(event.receivedAt)
    const prev = seen.get(key)
    if (prev !== undefined && ts - prev <= ttlMs) continue
    seen.set(key, ts)
    kept.push(event)
  }
  return kept
}

function deriveSideSignals(args: Readonly<{
  events: readonly TxEvent[]
  side: "buy" | "sell"
  kind: "convergence" | "sell-pressure"
  polarity: "bullish" | "bearish"
  windowMinutes: number
  minActors: number
  actorDedupeTtlMinutes: number
  observedAt: string
}>): DiscordWalletSignal[] {
  const windowEvents = args.events.filter((event) => (
    event.side === args.side
    && event.tokenContract
    && (event.confidence === "high" || event.confidence === "medium")
    && withinWindow(event.receivedAt, args.observedAt, args.windowMinutes)
  ))
  const deduped = dedupeByActorCaSide(windowEvents, args.actorDedupeTtlMinutes)
  const byToken = new Map<string, TxEvent[]>()
  for (const event of deduped) {
    const ca = normalizeCa(event.tokenContract!)
    const list = byToken.get(ca) ?? []
    list.push(event)
    byToken.set(ca, list)
  }
  const out: DiscordWalletSignal[] = []
  const windowMs = args.windowMinutes * 60_000
  const observedMs = Date.parse(args.observedAt)
  for (const [tokenContract, events] of byToken) {
    const actors = [...new Set(events.map((event) => normalizeActor(event.actor)))]
    if (actors.length < args.minActors) continue
    const times = events.map((event) => Date.parse(event.receivedAt)).filter(Number.isFinite)
    const earliest = Math.min(...times)
    out.push({
      kind: args.kind,
      polarity: args.polarity,
      ...(events.find((event) => event.chain)?.chain
        ? { chain: events.find((event) => event.chain)!.chain }
        : {}),
      tokenContract,
      actors: events
        .map((event) => event.actor)
        .filter((actor, index, all) => (
          all.findIndex((other) => normalizeActor(other) === normalizeActor(actor)) === index
        )),
      windowStart: new Date(Number.isFinite(earliest) ? earliest : observedMs - windowMs).toISOString(),
      windowEnd: new Date(observedMs).toISOString(),
      observedAt: args.observedAt,
    })
  }
  return out
}

export function deriveDiscordWalletSignals(args: Readonly<{
  events: readonly TxEvent[]
  observedAt: string
  actorDedupeTtlMinutes: number
  convergence: Readonly<{
    enabled: boolean
    windowMinutes: number
    minActors: number
  }>
  sellPressure: Readonly<{
    enabled: boolean
    windowMinutes: number
    minActors: number
  }>
}>): DiscordWalletSignal[] {
  const signals: DiscordWalletSignal[] = []
  if (args.convergence.enabled) {
    signals.push(...deriveSideSignals({
      events: args.events,
      side: "buy",
      kind: "convergence",
      polarity: "bullish",
      windowMinutes: args.convergence.windowMinutes,
      minActors: args.convergence.minActors,
      actorDedupeTtlMinutes: args.actorDedupeTtlMinutes,
      observedAt: args.observedAt,
    }))
  }
  if (args.sellPressure.enabled) {
    signals.push(...deriveSideSignals({
      events: args.events,
      side: "sell",
      kind: "sell-pressure",
      polarity: "bearish",
      windowMinutes: args.sellPressure.windowMinutes,
      minActors: args.sellPressure.minActors,
      actorDedupeTtlMinutes: args.actorDedupeTtlMinutes,
      observedAt: args.observedAt,
    }))
  }
  return signals
}
