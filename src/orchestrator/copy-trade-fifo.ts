import { materializeCopyTradeReturn, type PriceBar } from "./observations.js"

export type FifoTradeLeg = Readonly<{
  eventId: string
  side: "buy" | "sell"
  tradedAt: string
  amountRaw?: string
}>

export type FifoClose = Readonly<{
  buyEventId: string
  sellEventId: string
  boughtAt: string
  soldAt: string
  amountRaw: string
  realizedReturn: number
  holdHours: number
}>

const UNIT = 1n

function parseAmount(raw: string | undefined): bigint {
  if (!raw) return UNIT
  try {
    const n = BigInt(raw)
    return n > 0n ? n : UNIT
  } catch {
    return UNIT
  }
}

/**
 * Match sells against open buy lots FIFO. Partial sells OK. When amounts are
 * missing, each buy/sell is treated as unit size 1.
 */
export function matchFifoCloses(
  trades: readonly FifoTradeLeg[],
  price: (buyAt: string, sellAt: string) => number | undefined,
): FifoClose[] {
  const sorted = [...trades].sort((a, b) => {
    const dt = Date.parse(a.tradedAt) - Date.parse(b.tradedAt)
    if (dt !== 0) return dt
    if (a.side !== b.side) return a.side === "buy" ? -1 : 1
    return a.eventId.localeCompare(b.eventId)
  })

  type Lot = { eventId: string; boughtAt: string; remaining: bigint }
  const lots: Lot[] = []
  const closes: FifoClose[] = []

  for (const trade of sorted) {
    if (trade.side === "buy") {
      lots.push({
        eventId: trade.eventId,
        boughtAt: trade.tradedAt,
        remaining: parseAmount(trade.amountRaw),
      })
      continue
    }

    let sellLeft = parseAmount(trade.amountRaw)
    while (sellLeft > 0n && lots.length > 0) {
      const lot = lots[0]!
      const take = lot.remaining < sellLeft ? lot.remaining : sellLeft
      const ret = price(lot.boughtAt, trade.tradedAt)
      if (ret !== undefined) {
        closes.push({
          buyEventId: lot.eventId,
          sellEventId: trade.eventId,
          boughtAt: lot.boughtAt,
          soldAt: trade.tradedAt,
          amountRaw: take.toString(),
          realizedReturn: ret,
          holdHours: (Date.parse(trade.tradedAt) - Date.parse(lot.boughtAt)) / 3_600_000,
        })
      }
      lot.remaining -= take
      sellLeft -= take
      if (lot.remaining <= 0n) lots.shift()
    }
  }

  return closes
}

export function barPricedReturn(
  bars: readonly PriceBar[],
  entryTs: string,
  exitTs: string,
  feeBpsPerSide?: number,
): number | undefined {
  return materializeCopyTradeReturn({
    bars,
    entryTs,
    exitTs,
    ...(feeBpsPerSide !== undefined ? { feeBpsPerSide } : {}),
  })
}
