import { join } from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"
import type { SnapshotWriter } from "../lib/snapshot.js"
import { StateStore } from "../lib/state.js"
import { loadConfig } from "../lib/config.js"
import { getChain, validateAddress } from "../lib/chains.js"
import { ensureArchive, putMarketBlob } from "../lib/archive.js"
import {
  type FetchLike,
  type OhlcvCandle,
} from "../collectors/market/geckoterminal.js"
import { fetchSolanaAwareOhlcvPages } from "../collectors/market/ohlcv-resolve.js"
import { aggregateClosedCandles } from "../collectors/market/aggregate.js"
import {
  computeWilderRsi,
  computeVolumeZScore,
  computeEmaStructure,
  computeRangeBreakout,
} from "../collectors/market/indicators.js"
import { chartManifest, renderChartPng } from "../charts/render.js"

const FIFTEEN_MIN = 15 * 60
const ONE_HOUR = 60 * 60
const FOUR_HOUR = 4 * 60 * 60
const SAFE_PAIR = /^[A-Za-z0-9]+$/u
const CHART_MAX_BARS = 96
const INTER_SUBJECT_SLEEP_MS = 1_500

export type ChartCollectResult = Readonly<{
  snapshotNames: readonly string[]
  postCount: number
  subjectsConsidered: number
  chartsWritten: number
  skipAgent: boolean
  collectionStatus: "completed" | "degraded" | "skipped"
}>

function featureLine(label: string, value: unknown): string {
  if (value && typeof value === "object" && "valid" in (value as object)) {
    const v = value as { valid: boolean; value?: unknown; reason?: string; delta?: unknown }
    if (!v.valid) return `${label}=invalid:${v.reason ?? "unknown"}`
    if ("delta" in v && v.delta !== undefined) {
      return `${label}=${String(v.value)} delta=${String(v.delta)}`
    }
    if (typeof v.value === "object" && v.value !== null) {
      return `${label}=${JSON.stringify(v.value)}`
    }
    return `${label}=${String(v.value)}`
  }
  return `${label}=${String(value)}`
}

function safeTokenName(symbolDisplay: string | undefined, tokenAddress: string): string {
  return (symbolDisplay ?? tokenAddress).replace(/[^A-Za-z0-9]/gu, "").slice(0, 16) || "tok"
}

/** Trailing contiguous closed bars ending at the newest candle (E2). */
function selectTrailingContiguousSeries(
  candles: readonly OhlcvCandle[],
  intervalSeconds: number,
  maxBars: number,
): OhlcvCandle[] {
  if (candles.length < 2) return []
  const sorted = [...candles].sort((a, b) => a.startTime - b.startTime)
  let end = sorted.length - 1
  const run: OhlcvCandle[] = [sorted[end]!]
  while (run.length < maxBars && end > 0) {
    const prev = sorted[end - 1]!
    if (sorted[end]!.startTime - prev.startTime !== intervalSeconds) break
    run.unshift(prev)
    end -= 1
  }
  return run.length >= 2 ? run : []
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function collectChartSweep(args: Readonly<{
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  agentRoot: string
  archiveRoot: string
  fetcher?: FetchLike
  sleep?: (ms: number) => Promise<void>
}>): Promise<ChartCollectResult> {
  const config = loadConfig()
  const store = new StateStore(join(args.agentRoot, "state"))
  const watchlist = store.loadWatchlist()
  const active = watchlist.entries.filter((e) => (
    e.status === "tracking" || e.status === "watching"
  ))
  const reportDir = join(args.agentRoot, "reports", args.runId)
  mkdirSync(reportDir, { recursive: true, mode: 0o700 })
  const sleep = args.sleep ?? defaultSleep

  if (active.length === 0) {
    await args.writer.writeInbox(args.runId, "chart-collection-status", {
      source: "host.collector",
      fetchedAt: args.fetchedAt,
      trust: "untrusted-external",
      items: [{
        provenance: `${args.runId}:chart-status`,
        text: "status=skipped reason=no-active-watchlist-subjects",
        ts: args.fetchedAt,
        ageSec: 0,
        freshnessTier: "live",
      }],
    })
    writeFileSync(
      join(reportDir, "chart-sweep-host.json"),
      `${JSON.stringify({
        status: "skipped",
        skippedReason: "no-active-watchlist-subjects",
        subjectsConsidered: 0,
        chartsWritten: 0,
      }, null, 2)}\n`,
    )
    return {
      snapshotNames: ["chart-collection-status"],
      postCount: 1,
      subjectsConsidered: 0,
      chartsWritten: 0,
      skipAgent: true,
      collectionStatus: "skipped",
    }
  }

  const archive = await ensureArchive(args.archiveRoot)
  const fetcher = args.fetcher ?? fetch
  const asOf = Math.floor(Date.parse(args.fetchedAt) / 1_000)
  const names: string[] = []
  let chartsWritten = 0
  const seenPairs = new Set<string>()
  const statusLines: string[] = []
  let subjectAttempts = 0

  for (const entry of active) {
    const { chain, tokenAddress, pairAddress, symbolDisplay } = entry.identity
    const chainEntry = getChain(chain)
    const pairKey = `${chain}:${pairAddress}`.toLowerCase()
    if (seenPairs.has(pairKey)) continue
    seenPairs.add(pairKey)

    if (!chainEntry || !SAFE_PAIR.test(pairAddress) || pairAddress.includes(":")) {
      statusLines.push(
        `subject=${symbolDisplay ?? tokenAddress} status=invalid-pair-binding pair=${pairAddress}`,
      )
      continue
    }
    if (!validateAddress(chainEntry.addressFormat, tokenAddress)) {
      statusLines.push(`subject=${symbolDisplay ?? tokenAddress} status=invalid-token-address`)
      continue
    }

    try {
      const { candles: raw15m, source: ohlcvSource } = await fetchSolanaAwareOhlcvPages({
        fetcher,
        chain,
        tokenAddress,
        network: chainEntry.geckoterminalNetwork,
        poolAddress: pairAddress,
        aggregateMinutes: 15,
        limit: 1_000,
        asOfEpochSeconds: asOf,
        maxPages: 3,
      })
      const candles1h = aggregateClosedCandles(raw15m, FIFTEEN_MIN, ONE_HOUR)
      const candles4h = aggregateClosedCandles(raw15m, FIFTEEN_MIN, FOUR_HOUR)
      const blobHash = await putMarketBlob(archive, {
        chain,
        pairAddress,
        intervalSeconds: FIFTEEN_MIN,
        asOf,
        candles: raw15m.map((c) => ({
          startTime: c.startTime,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        })),
      })

      let rsi1h = computeWilderRsi(
        candles1h,
        ONE_HOUR,
        config.indicators.rsi_period,
        config.indicators.rsi_min_active_bars,
      )
      let rsi4h = computeWilderRsi(
        candles4h,
        FOUR_HOUR,
        config.indicators.rsi_period,
        config.indicators.rsi_min_active_bars,
      )
      let volZ = computeVolumeZScore(candles1h, ONE_HOUR)
      let ema = computeEmaStructure(candles1h, ONE_HOUR)
      let breakout = computeRangeBreakout(candles1h, ONE_HOUR)

      const chart1h = selectTrailingContiguousSeries(candles1h, ONE_HOUR, CHART_MAX_BARS)
      const chart15m = selectTrailingContiguousSeries(raw15m, FIFTEEN_MIN, CHART_MAX_BARS)
      let chartSeries = chart1h
      let chartTimeframe = ONE_HOUR
      let chartStatus = "ok"
      if (chartSeries.length < 2 && chart15m.length >= 2) {
        chartSeries = chart15m
        chartTimeframe = FIFTEEN_MIN
        chartStatus = "chart-15m-fallback"
        if (!rsi1h.valid || !rsi4h.valid) {
          rsi1h = computeWilderRsi(
            chart15m,
            FIFTEEN_MIN,
            config.indicators.rsi_period,
            config.indicators.rsi_min_active_bars,
          )
          volZ = computeVolumeZScore(chart15m, FIFTEEN_MIN)
          ema = computeEmaStructure(chart15m, FIFTEEN_MIN)
          breakout = computeRangeBreakout(chart15m, FIFTEEN_MIN)
        }
      } else if (chartSeries.length < 2) {
        chartStatus = "chart-insufficient-bars"
      }

      let imageHash: string | undefined
      let candleHash: string | undefined
      const safeSym = safeTokenName(symbolDisplay, tokenAddress)
      if (chartSeries.length >= 2) {
        try {
          const png = renderChartPng(chartSeries, chartTimeframe)
          const suffix = chartTimeframe === ONE_HOUR ? "1h" : "15m"
          const written = await args.writer.writeChartPng(args.runId, `chart-${safeSym}-${suffix}`, png)
          const manifest = chartManifest(chartSeries, pairAddress, chartTimeframe)
          imageHash = written.hash
          candleHash = manifest.candleHash
          await args.writer.writeInbox(args.runId, `chart-manifest-${safeSym}`, {
            source: "host.chart",
            fetchedAt: args.fetchedAt,
            trust: "untrusted-external",
            items: [{
              provenance: `${args.runId}:chart-manifest:${pairAddress}`,
              text: [
                `pair=${pairAddress}`,
                `timeframeSeconds=${chartTimeframe}`,
                `candleHash=${manifest.candleHash}`,
                `imageHash=${manifest.imageHash}`,
                `featureSpecVersion=${manifest.featureSpecVersion}`,
                `barCutoff=${manifest.barCutoff}`,
                `sourceBlob=${blobHash}`,
              ].join(" "),
              ts: args.fetchedAt,
              ageSec: 0,
              freshnessTier: "live",
            }],
          })
          names.push(`chart-manifest-${safeSym}`)
          chartsWritten += 1
        } catch {
          statusLines.push(`subject=${symbolDisplay ?? tokenAddress} status=chart-render-skipped`)
        }
      }

      const safeName = `chart-indicators-${safeSym}`
      await args.writer.writeInbox(args.runId, safeName, {
        source: "host.indicators",
        fetchedAt: args.fetchedAt,
        trust: "untrusted-external",
        items: [{
          provenance: `${args.runId}:indicators:${pairAddress}`,
          text: [
            `chain=${chain}`,
            `token=${tokenAddress}`,
            `pair=${pairAddress}`,
            `symbol=${symbolDisplay ?? ""}`,
            `sourceBlob=${blobHash}`,
            `ohlcvSource=${ohlcvSource}`,
            featureLine("rsi1h", rsi1h),
            featureLine("rsi4h", rsi4h),
            featureLine("volZ", volZ),
            featureLine("ema", ema),
            featureLine("breakout", breakout),
            imageHash ? `imageHash=${imageHash}` : "imageHash=",
            candleHash ? `candleHash=${candleHash}` : "candleHash=",
          ].join(" "),
          ts: args.fetchedAt,
          ageSec: 0,
          freshnessTier: "live",
        }],
      })
      names.push(safeName)
      statusLines.push(
        `subject=${symbolDisplay ?? tokenAddress} status=${chartStatus}`
          + ` candles15m=${raw15m.length} ohlcvSource=${ohlcvSource}`,
      )
    } catch (error) {
      statusLines.push(
        `subject=${symbolDisplay ?? tokenAddress} status=provider-error`
          + ` detail=${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`,
      )
    } finally {
      subjectAttempts += 1
      if (subjectAttempts < active.length) {
        await sleep(INTER_SUBJECT_SLEEP_MS)
      }
    }
  }

  await args.writer.writeInbox(args.runId, "chart-collection-status", {
    source: "host.collector",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: statusLines.map((text, i) => ({
      provenance: `${args.runId}:chart-status:${i}`,
      text,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live" as const,
    })),
  })
  names.push("chart-collection-status")

  const skipAgent = chartsWritten === 0
  writeFileSync(
    join(reportDir, "chart-sweep-host.json"),
    `${JSON.stringify({
      status: chartsWritten > 0 ? "completed" : "degraded",
      subjectsConsidered: active.length,
      chartsWritten,
      skipAgent,
    }, null, 2)}\n`,
  )

  return {
    snapshotNames: names,
    postCount: names.length,
    subjectsConsidered: active.length,
    chartsWritten,
    skipAgent,
    collectionStatus: chartsWritten > 0 ? "completed" : "degraded",
  }
}
