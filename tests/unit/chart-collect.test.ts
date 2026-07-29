import { describe, expect, it, vi } from "vitest"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { StateStore } from "../../src/lib/state.js"
import { collectChartSweep } from "../../src/orchestrator/chart-collect.js"

const NOW = "2026-07-18T12:00:00.000Z"

function geckoPayload(candles: unknown[]) {
  return JSON.stringify({
    data: { attributes: { ohlcv_list: candles } },
  })
}

function watchlistEntry(pairAddress: string, symbolDisplay: string) {
  return {
    schema: 1 as const,
    identity: {
      chain: "solana" as const,
      tokenAddress: "So11111111111111111111111111111111111111112",
      pairAddress,
      symbolDisplay,
      resolution: "resolved" as const,
    },
    status: "tracking" as const,
    addedAt: NOW,
    updatedAt: NOW,
  }
}

describe("collectChartSweep 15m fallback and pacing", () => {
  it("falls back to 15m PNG when 1h aggregation is too gappy", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tc-chart-15m-")))
    const archive = mkdtempSync(join(tmpdir(), "tc-arch-15m-"))
    mkdirSync(join(root, "state"), { recursive: true })
    const state = new StateStore(join(root, "state"))
    await state.saveWatchlist({
      schema: 1,
      entries: [watchlistEntry("So11111111111111111111111111111111111111112", "SOL")],
    })

    const asOf = Math.floor(Date.parse(NOW) / 1_000)
    const hourBucket = Math.floor((asOf - 900) / 3600) * 3600 - 3600
    const completeHour = Array.from({ length: 4 }, (_, i) => [
      hourBucket + i * 900,
      100 + i,
      101 + i,
      99 + i,
      100.5 + i,
      1_000 + i,
    ])
    const recent15m = [
      [asOf - 1800, 110, 111, 109, 110.5, 500],
      [asOf - 900, 111, 112, 110, 111.5, 600],
    ]

    const result = await collectChartSweep({
      runId: "chart-sweep-15m-fallback",
      writer: new SnapshotWriter(root),
      fetchedAt: NOW,
      agentRoot: root,
      archiveRoot: archive,
      fetcher: async () => new Response(geckoPayload([...completeHour, ...recent15m]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    })

    expect(result.chartsWritten).toBeGreaterThanOrEqual(1)
    expect(result.skipAgent).toBe(false)
    expect(result.snapshotNames.some((n) => n.startsWith("chart-manifest-"))).toBe(true)
    const host = JSON.parse(readFileSync(
      join(root, "reports", "chart-sweep-15m-fallback", "chart-sweep-host.json"),
      "utf8",
    )) as { skipAgent?: boolean }
    expect(host.skipAgent).toBe(false)
  })

  it("sleeps between subjects N-1 times for N active entries", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tc-chart-sleep-")))
    const archive = mkdtempSync(join(tmpdir(), "tc-arch-sleep-"))
    mkdirSync(join(root, "state"), { recursive: true })
    const state = new StateStore(join(root, "state"))
    await state.saveWatchlist({
      schema: 1,
      entries: [
        watchlistEntry("PairAddress1111111111111111111111111111111", "A"),
        watchlistEntry("PairAddress2222222222222222222222222222222", "B"),
        watchlistEntry("PairAddress3333333333333333333333333333333", "C"),
      ],
    })

    const asOf = Math.floor(Date.parse(NOW) / 1_000)
    const candles = Array.from({ length: 8 }, (_, index) => [
      asOf - (8 - index) * 900,
      100 + index,
      101 + index,
      99 + index,
      100.5 + index,
      1_000 + index,
    ])
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {})

    await collectChartSweep({
      runId: "chart-sweep-sleep",
      writer: new SnapshotWriter(root),
      fetchedAt: NOW,
      agentRoot: root,
      archiveRoot: archive,
      sleep,
      fetcher: async () => new Response(geckoPayload(candles), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    })

    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls.every(([ms]) => ms === 1_500)).toBe(true)
  })

  it("degrades with provider-error status when every subject fails", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tc-chart-all-fail-")))
    const archive = mkdtempSync(join(tmpdir(), "tc-arch-all-fail-"))
    mkdirSync(join(root, "state"), { recursive: true })
    const state = new StateStore(join(root, "state"))
    await state.saveWatchlist({
      schema: 1,
      entries: [watchlistEntry("So11111111111111111111111111111111111111112", "SOL")],
    })

    const result = await collectChartSweep({
      runId: "chart-sweep-all-fail",
      writer: new SnapshotWriter(root),
      fetchedAt: NOW,
      agentRoot: root,
      archiveRoot: archive,
      fetcher: async () => new Response("down", { status: 503 }),
    })

    expect(result.chartsWritten).toBe(0)
    expect(result.skipAgent).toBe(true)
    const statusPath = join(
      root,
      "inbox",
      "chart-sweep-all-fail",
      "chart-collection-status.json",
    )
    expect(existsSync(statusPath)).toBe(true)
    const status = readFileSync(statusPath, "utf8")
    expect(status).toMatch(/provider-error/u)
  })
})
