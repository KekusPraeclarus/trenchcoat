import { join } from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"
import type { SnapshotWriter } from "../lib/snapshot.js"
import { StateStore } from "../lib/state.js"
import { loadConfig } from "../lib/config.js"
import { getChain, validateAddress } from "../lib/chains.js"
import { ensureArchive, putMarketBlob } from "../lib/archive.js"
import {
  fetchClosedOhlcvPages,
  type FetchLike,
} from "../collectors/market/geckoterminal.js"
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

export async function collectChartSweep(args: Readonly<{
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  agentRoot: string
  archiveRoot: string
  fetcher?: FetchLike
}>): Promise<ChartCollectResult> {
  const config = loadConfig()
  const store = new StateStore(join(args.agentRoot, "state"))
  const watchlist = store.loadWatchlist()
  const active = watchlist.entries.filter((e) => (
    e.status === "tracking" || e.status === "watching"
  ))
  const reportDir = join(args.agentRoot, "reports", args.runId)
  mkdirSync(reportDir, { recursive: true, mode: 0o700 })

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
      const raw15m = await fetchClosedOhlcvPages(
        fetcher,
        {
          network: chainEntry.geckoterminalNetwork,
          poolAddress: pairAddress,
          aggregateMinutes: 15,
          limit: 1_000,
        },
        asOf,
        3,
      )
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

      const rsi1h = computeWilderRsi(
        candles1h,
        ONE_HOUR,
        config.indicators.rsi_period,
        config.indicators.rsi_min_active_bars,
      )
      const rsi4h = computeWilderRsi(
        candles4h,
        FOUR_HOUR,
        config.indicators.rsi_period,
        config.indicators.rsi_min_active_bars,
      )
      const volZ = computeVolumeZScore(candles1h, ONE_HOUR)
      const ema = computeEmaStructure(candles1h, ONE_HOUR)
      const breakout = computeRangeBreakout(candles1h, ONE_HOUR)

      const chartSeries = candles1h.slice(-96)
      let imageHash: string | undefined
      let candleHash: string | undefined
      const safeSym = safeTokenName(symbolDisplay, tokenAddress)
      if (chartSeries.length >= 2) {
        try {
          const png = renderChartPng(chartSeries, ONE_HOUR)
          const written = await args.writer.writeChartPng(args.runId, `chart-${safeSym}-1h`, png)
          const manifest = chartManifest(chartSeries, pairAddress, ONE_HOUR)
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
                `timeframeSeconds=${ONE_HOUR}`,
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
      statusLines.push(`subject=${symbolDisplay ?? tokenAddress} status=ok candles15m=${raw15m.length}`)
    } catch (error) {
      statusLines.push(
        `subject=${symbolDisplay ?? tokenAddress} status=provider-error`
          + ` detail=${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`,
      )
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
