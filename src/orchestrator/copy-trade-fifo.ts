import {
  copyTradePriceability,
  materializeCopyTradeReturn,
  type CopyTradePriceability,
  type PriceBar,
} from "./observations.js"

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

export type FifoSellAttemptKind = "sell-only" | CopyTradePriceability

export type FifoSellAttempt = Readonly<{
  sellEventId: string
  buyEventId?: string
  boughtAt?: string
  soldAt?: string
  kind: FifoSellAttemptKind
  close?: FifoClose
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

/**
 * Classify each sell leg: sell-only, provider-pending, non-priceable, or priced.
 * Mirrors FIFO lot consumption in matchFifoCloses.
 */
export function classifyFifoSellAttempts(
  trades: readonly FifoTradeLeg[],
  bars: readonly PriceBar[],
  feeBpsPerSide?: number,
): FifoSellAttempt[] {
  const sorted = [...trades].sort((a, b) => {
    const dt = Date.parse(a.tradedAt) - Date.parse(b.tradedAt)
    if (dt !== 0) return dt
    if (a.side !== b.side) return a.side === "buy" ? -1 : 1
    return a.eventId.localeCompare(b.eventId)
  })

  type Lot = { eventId: string; boughtAt: string; remaining: bigint }
  const lots: Lot[] = []
  const attempts: FifoSellAttempt[] = []

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
    let recorded = false
    while (sellLeft > 0n && lots.length > 0) {
      const lot = lots[0]!
      const take = lot.remaining < sellLeft ? lot.remaining : sellLeft
      if (!recorded) {
        recorded = true
        const priceability = copyTradePriceability({
          bars,
          entryTs: lot.boughtAt,
          exitTs: trade.tradedAt,
        })
        if (priceability === "priced") {
          const ret = materializeCopyTradeReturn({
            bars,
            entryTs: lot.boughtAt,
            exitTs: trade.tradedAt,
            ...(feeBpsPerSide !== undefined ? { feeBpsPerSide } : {}),
          })
          if (ret !== undefined) {
            attempts.push({
              sellEventId: trade.eventId,
              buyEventId: lot.eventId,
              boughtAt: lot.boughtAt,
              soldAt: trade.tradedAt,
              kind: "priced",
              close: {
                buyEventId: lot.eventId,
                sellEventId: trade.eventId,
                boughtAt: lot.boughtAt,
                soldAt: trade.tradedAt,
                amountRaw: take.toString(),
                realizedReturn: ret,
                holdHours: (Date.parse(trade.tradedAt) - Date.parse(lot.boughtAt)) / 3_600_000,
              },
            })
          }
        } else {
          attempts.push({
            sellEventId: trade.eventId,
            buyEventId: lot.eventId,
            boughtAt: lot.boughtAt,
            soldAt: trade.tradedAt,
            kind: priceability,
          })
        }
      }
      lot.remaining -= take
      sellLeft -= take
      if (lot.remaining <= 0n) lots.shift()
    }

    if (!recorded) {
      attempts.push({
        sellEventId: trade.eventId,
        kind: "sell-only",
      })
    }
  }

  return attempts
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
