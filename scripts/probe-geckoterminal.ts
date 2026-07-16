import {
  fetchClosedOhlcv,
  FIVE_MINUTES_SECONDS,
} from "../src/collectors/market/geckoterminal.js"

const network = process.argv[2] ?? "eth"
const pool = process.argv[3] ?? "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"
const asOf = Math.floor(Date.now() / 1_000)

const candles = await fetchClosedOhlcv(globalThis.fetch, {
  network,
  poolAddress: pool,
  aggregateMinutes: 5,
  limit: 20,
}, asOf)

const last = candles.at(-1)
if (!last) {
  console.error("No closed candles returned")
  process.exit(2)
}

if ((last.startTime + FIVE_MINUTES_SECONDS) > asOf) {
  console.error("Open candle leaked into closed series")
  process.exit(2)
}

console.log(JSON.stringify({
  network,
  pool,
  asOf,
  count: candles.length,
  first: candles[0]?.startTime,
  last: last.startTime,
}, null, 2))
