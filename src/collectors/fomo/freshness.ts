export const LIVE_SEC = 6 * 3_600
export const STALE_VISIBLE_SEC = 24 * 3_600
export const MAX_FUTURE_SKEW_MS = 5 * 60_000

export type FreshnessTier = "live" | "stale" | "expired"

export function asIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1_000
    const iso = new Date(ms).toISOString()
    return Number.isFinite(Date.parse(iso)) ? iso : undefined
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) return undefined
    return new Date(parsed).toISOString()
  }
  return undefined
}

export function freshnessTierForAge(ageSec: number): FreshnessTier {
  if (ageSec <= LIVE_SEC) return "live"
  if (ageSec <= STALE_VISIBLE_SEC) return "stale"
  return "expired"
}

export function freshnessFromIso(
  eventIso: string | undefined,
  fetchedAt: string,
  opts: Readonly<{ maxFutureSkewMs?: number }> = {},
): Readonly<{
  ok: boolean
  reason?: string
  ts?: string
  ageSec?: number
  freshnessTier?: FreshnessTier
}> {
  if (!eventIso) return { ok: false, reason: "missing-timestamp" }
  const eventMs = Date.parse(eventIso)
  const fetchedMs = Date.parse(fetchedAt)
  if (!Number.isFinite(eventMs) || !Number.isFinite(fetchedMs)) {
    return { ok: false, reason: "invalid-timestamp" }
  }
  const skew = opts.maxFutureSkewMs ?? MAX_FUTURE_SKEW_MS
  if (eventMs - fetchedMs > skew) {
    return { ok: false, reason: "future-timestamp" }
  }
  const ageSec = Math.max(0, Math.floor((fetchedMs - eventMs) / 1_000))
  return {
    ok: true,
    ts: new Date(eventMs).toISOString(),
    ageSec,
    freshnessTier: freshnessTierForAge(ageSec),
  }
}

export function isLiveEligible(ageSec: number): boolean {
  return ageSec <= LIVE_SEC
}

export function snapshotFieldsFromEvent(
  eventIso: string | undefined,
  fetchedAt: string,
): Readonly<{
  accepted: boolean
  reason?: string
  ts: string
  ageSec: number
  freshnessTier: FreshnessTier
}> {
  const result = freshnessFromIso(eventIso, fetchedAt)
  if (!result.ok || result.ts === undefined || result.ageSec === undefined || !result.freshnessTier) {
    return {
      accepted: false,
      reason: result.reason ?? "missing-timestamp",
      ts: fetchedAt,
      ageSec: 0,
      freshnessTier: "expired",
    }
  }
  return {
    accepted: isLiveEligible(result.ageSec),
    ...(isLiveEligible(result.ageSec) ? {} : { reason: "stale-event" }),
    ts: result.ts,
    ageSec: result.ageSec,
    freshnessTier: result.freshnessTier,
  }
}

export function pointInTimeSnapshot(observedAt: string, fetchedAt: string): Readonly<{
  ts: string
  ageSec: number
  freshnessTier: FreshnessTier
}> {
  const result = freshnessFromIso(observedAt, fetchedAt)
  if (!result.ok || result.ts === undefined || result.ageSec === undefined || !result.freshnessTier) {
    return { ts: fetchedAt, ageSec: 0, freshnessTier: "live" }
  }
  return {
    ts: result.ts,
    ageSec: result.ageSec,
    freshnessTier: result.freshnessTier,
  }
}
