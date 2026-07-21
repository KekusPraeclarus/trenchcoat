import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { SnapshotWriter } from "../lib/snapshot.js"
import { loadConfig, type TrenchcoatConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { enqueueResearch } from "../lib/research-queue.js"
import type { ResearchQueueEntry } from "../contracts/schemas.js"
import { FomoWebClient, type FomoDataSource } from "../collectors/fomo/web-client.js"
import { providerGateAllowsSchedule, requireGatePass } from "../collectors/fomo/gates.js"
import { FomoClientError } from "../collectors/fomo/types.js"
import { snapshotFieldsFromEvent } from "../collectors/fomo/freshness.js"
import {
  dedupeTradeEvents,
  deriveConvergence,
  derivePressure,
  qualifiedHandleSet,
  trendingSignals,
} from "../collectors/fomo/derive.js"
import {
  emptyObservationCache,
  loadObservationCache,
  mergeObservations,
  saveObservationCache,
  type FomoObservation,
} from "../collectors/fomo/observations.js"
import { fomoSessionExists } from "../collectors/social/fomo-auth.js"
import { resolveResearchSubject } from "./research-collect.js"
import type { CollectionSummary } from "./collect.js"
import type { FetchLike } from "../collectors/market/geckoterminal.js"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { isNativeOrWrapMint } from "../lib/native-mints.js"

function expiryIso(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) + days * 86_400_000).toISOString()
}

function eventHash(parts: Readonly<Record<string, string | number | undefined>>): string {
  const stable = Object.keys(parts).sort().map((key) => `${key}=${parts[key] ?? ""}`).join("|")
  return createHash("sha256").update(stable).digest("hex").slice(0, 24)
}

function cursorPath(archiveRoot: string): string {
  return join(archiveRoot, "provider-cursors", "fomo", "activity.json")
}

function enqueueReceiptPath(archiveRoot: string, day: string): string {
  return join(archiveRoot, "provider-usage", "fomo", `enqueues-${day}.json`)
}

async function loadPollCursor(archiveRoot: string): Promise<string | undefined> {
  const path = cursorPath(archiveRoot)
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { since?: string }
    return raw.since
  } catch {
    return undefined
  }
}

async function savePollCursor(archiveRoot: string, since: string): Promise<void> {
  await writeAtomicFile(cursorPath(archiveRoot), `${JSON.stringify({ schema: 1, since }, null, 2)}\n`)
}

async function loadEnqueueCount(archiveRoot: string, day: string): Promise<number> {
  const path = enqueueReceiptPath(archiveRoot, day)
  if (!existsSync(path)) return 0
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { count?: number }
    return Number(raw.count ?? 0)
  } catch {
    return 0
  }
}

async function saveEnqueueCount(archiveRoot: string, day: string, count: number): Promise<void> {
  await writeAtomicFile(enqueueReceiptPath(archiveRoot, day), `${JSON.stringify({ schema: 1, day, count }, null, 2)}\n`)
}

function skipSummary(names: string[], status: string): CollectionSummary {
  return {
    snapshotNames: names,
    fypAuthors: [],
    discoverySightings: [],
    fcDiscoverySightings: [],
    fypPosts: [],
    fypCasts: [],
    postCount: 0,
    skipAgent: true,
    collectionKind: "host-only",
    collectionStatus: status,
  }
}

async function writeSkip(
  args: Readonly<{ runId: string, writer: SnapshotWriter, fetchedAt: string }>,
  reason: string,
): Promise<string[]> {
  await args.writer.writeInbox(args.runId, "collection-status", {
    source: "host.fomo-signal-scan",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:fomo:${reason}`,
      text: `kind=skip reason=${reason}`,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
    }],
  })
  return ["collection-status"]
}

export async function collectFomoSignalScan(args: Readonly<{
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  agentRoot: string
  archiveRoot: string
  fetcher?: FetchLike
  client?: FomoDataSource
  /** Test injection — production callers omit and use loadConfig() */
  config?: TrenchcoatConfig
}>): Promise<CollectionSummary> {
  const config = args.config ?? loadConfig()
  const snapshotNames: string[] = []

  if (!config.fomo.enabled || !config.fomo.signal_scan.enabled) {
    return skipSummary(await writeSkip(args, "fomo-disabled"), "fomo-disabled")
  }
  if (!providerGateAllowsSchedule(args.archiveRoot)) {
    return skipSummary(await writeSkip(args, "fomo-provider-gate"), "fomo-provider-gate")
  }
  // Injected clients are for fixtures/tests; live scrape still requires burner session
  if (!args.client && !fomoSessionExists()) {
    return skipSummary(await writeSkip(args, "fomo-missing-session"), "fomo-missing-session")
  }

  const client = args.client ?? new FomoWebClient({
    archiveRoot: args.archiveRoot,
    dailyNavigationBudget: config.fomo.daily_navigation_budget,
    minDelayMs: config.fomo.min_delay_ms,
    maxDelayMs: config.fomo.max_delay_ms,
    navigationTimeoutMs: config.fomo.navigation_timeout_ms,
    maxPayloadBytes: config.fomo.max_payload_bytes,
  })

  type Candidate = Readonly<{
    kind: "convergence" | "hot" | "activity" | "buy-pressure" | "sell-pressure"
    chain: string
    tokenAddress: string
    symbol?: string
    handles: readonly string[]
    eventAt?: string
  }>
  const candidates: Candidate[] = []
  const signalLines: string[] = []
  const observations: FomoObservation[] = []
  let latestEventAt: string | undefined

  try {
    const leaderboard = requireGatePass(args.archiveRoot, "leaderboard").ok
      ? await client.getLeaderboard({ timeframe: "7d", limit: 50 })
      : []
    const qualified = qualifiedHandleSet(leaderboard)
    for (const entry of leaderboard) {
      observations.push({ kind: "leaderboard", record: entry })
    }

    let trades = [] as Awaited<ReturnType<FomoDataSource["readFeed"]>>
    if (config.fomo.signal_scan.feed && requireGatePass(args.archiveRoot, "feed").ok) {
      trades = await client.readFeed({ limit: 100 })
    }
    if (config.fomo.signal_scan.alerts && requireGatePass(args.archiveRoot, "alerts").ok) {
      const alerts = await client.readAlerts({ limit: 100 })
      for (const alert of alerts) {
        observations.push({ kind: "alert", record: alert })
        if (alert.action && alert.chain && alert.tokenAddress) {
          trades.push({
            ...(alert.sourceId ? { sourceId: alert.sourceId } : {}),
            ...(alert.handle ? { handle: alert.handle } : {}),
            action: alert.action,
            chain: alert.chain,
            tokenAddress: alert.tokenAddress,
            ...(alert.symbol ? { symbol: alert.symbol } : {}),
            ...(alert.usdAmount !== undefined ? { usdAmount: alert.usdAmount } : {}),
            eventAt: alert.eventAt,
            observedAt: alert.observedAt,
          })
        }
      }
    }

    const since = await loadPollCursor(args.archiveRoot)
    const acceptedTrades = dedupeTradeEvents(trades).filter((trade) => {
      const fields = snapshotFieldsFromEvent(trade.eventAt, args.fetchedAt)
      if (!fields.accepted) return false
      if (since && Date.parse(trade.eventAt) <= Date.parse(since)) return false
      return true
    })
    for (const trade of acceptedTrades) {
      observations.push({ kind: "trade", record: trade })
      if (!latestEventAt || Date.parse(trade.eventAt) > Date.parse(latestEventAt)) {
        latestEventAt = trade.eventAt
      }
      if (
        trade.action === "buy"
        && trade.chain
        && trade.tokenAddress
        && trade.usdAmount !== undefined
        && trade.usdAmount >= config.fomo.signal_scan.min_trade_usd
      ) {
        candidates.push({
          kind: "activity",
          chain: trade.chain,
          tokenAddress: trade.tokenAddress,
          ...(trade.symbol ? { symbol: trade.symbol } : {}),
          handles: trade.handle ? [trade.handle] : [],
          eventAt: trade.eventAt,
        })
        signalLines.push(
          `kind=activity chain=${trade.chain} token=${trade.tokenAddress}`
            + (trade.handle ? ` handle=${trade.handle}` : "")
            + ` usd=${trade.usdAmount} eventAt=${trade.eventAt}`,
        )
      }
    }

    if (config.fomo.signal_scan.convergence) {
      for (const signal of deriveConvergence({
        events: acceptedTrades,
        qualifiedHandles: qualified,
        windowMinutes: config.fomo.signal_scan.convergence_window_minutes,
        minTraders: config.fomo.signal_scan.min_converging_traders,
        observedAt: args.fetchedAt,
      })) {
        observations.push({ kind: "signal", record: signal })
        candidates.push({
          kind: "convergence",
          chain: signal.chain,
          tokenAddress: signal.tokenAddress,
          ...(signal.symbol ? { symbol: signal.symbol } : {}),
          handles: signal.handles,
          eventAt: signal.windowEnd,
        })
        signalLines.push(
          `kind=convergence chain=${signal.chain} token=${signal.tokenAddress} handles=${signal.handles.join(",")}`,
        )
      }
    }

    if (config.fomo.signal_scan.pressure) {
      for (const side of ["buy", "sell"] as const) {
        for (const signal of derivePressure({
          events: acceptedTrades,
          qualifiedHandles: qualified,
          windowMinutes: config.fomo.signal_scan.pressure_window_minutes,
          minTraders: config.fomo.signal_scan.min_pressure_traders,
          side,
          observedAt: args.fetchedAt,
        })) {
          observations.push({ kind: "signal", record: signal })
          candidates.push({
            kind: side === "buy" ? "buy-pressure" : "sell-pressure",
            chain: signal.chain,
            tokenAddress: signal.tokenAddress,
            ...(signal.symbol ? { symbol: signal.symbol } : {}),
            handles: signal.handles,
            eventAt: signal.windowEnd,
          })
          signalLines.push(
            `kind=${signal.kind} chain=${signal.chain} token=${signal.tokenAddress} handles=${signal.handles.join(",")}`,
          )
        }
      }
    }

    if (config.fomo.signal_scan.trending && requireGatePass(args.archiveRoot, "trending").ok) {
      const hot = await client.getHotTokens({ limit: 10 })
      for (const token of hot) {
        observations.push({ kind: "trending", record: token })
      }
      for (const signal of trendingSignals(hot, args.fetchedAt, 10)) {
        observations.push({ kind: "signal", record: signal })
        candidates.push({
          kind: "hot",
          chain: signal.chain,
          tokenAddress: signal.tokenAddress,
          ...(signal.symbol ? { symbol: signal.symbol } : {}),
          handles: [],
          eventAt: signal.observedAt,
        })
        signalLines.push(`kind=hot chain=${signal.chain} token=${signal.tokenAddress}`)
      }
    }

    const cache = loadObservationCache(args.archiveRoot) ?? emptyObservationCache(args.fetchedAt)
    const merged = mergeObservations(cache, observations, args.fetchedAt)
    await saveObservationCache(args.archiveRoot, merged)
    if (latestEventAt) await savePollCursor(args.archiveRoot, latestEventAt)
  } catch (error) {
    const reason = error instanceof FomoClientError ? error.code : "upstream"
    if (!args.client) await client.close?.().catch(() => undefined)
    return skipSummary(await writeSkip(args, `fomo-upstream code=${reason}`), "fomo-upstream-unavailable")
  } finally {
    if (!args.client) await client.close?.().catch(() => undefined)
  }

  if (signalLines.length > 0) {
    await args.writer.writeInbox(args.runId, "fomo-signals", {
      source: "host.fomo-signal-scan",
      fetchedAt: args.fetchedAt,
      trust: "untrusted-external",
      items: signalLines.flatMap((text, index) => {
        const eventAtMatch = text.match(/eventAt=([^\s]+)/u)
        const fields = snapshotFieldsFromEvent(eventAtMatch?.[1] ?? args.fetchedAt, args.fetchedAt)
        if (!fields.accepted && eventAtMatch) return []
        return [{
          provenance: `${args.runId}:fomo:signal:${index}`,
          text: text.slice(0, 20_000),
          ts: fields.ts,
          ageSec: fields.ageSec,
          freshnessTier: fields.freshnessTier,
        }]
      }),
    })
    snapshotNames.push("fomo-signals")
  }

  let enqueued = 0
  if (!config.fomo.shadow_mode && candidates.length > 0) {
    const day = args.fetchedAt.slice(0, 10)
    let used = await loadEnqueueCount(args.archiveRoot, day)
    const state = new StateStore(join(args.agentRoot, "state"))
    let queue = state.loadResearchQueue()
    const watchlist = state.loadWatchlist()
    const watchlistKeys = new Set(
      watchlist.entries.map((entry) => `${entry.identity.chain}:${entry.identity.tokenAddress}`),
    )
    const recentKeys = new Set(
      queue.entries
        .filter((entry) => Date.parse(args.fetchedAt) - Date.parse(entry.firstSeen) <= 7 * 86_400_000)
        .map((entry) => `${entry.chain}:${entry.tokenAddress}`),
    )

    for (const candidate of candidates) {
      if (used >= config.fomo.signal_scan.max_enqueues_per_day) break
      if (isNativeOrWrapMint(candidate.tokenAddress, candidate.symbol)) continue
      const key = `${candidate.chain}:${candidate.tokenAddress}`
      if (watchlistKeys.has(key) || recentKeys.has(key)) continue
      const subject = key
      const resolved = await resolveResearchSubject(
        { subject },
        args.fetcher ?? globalThis.fetch,
      )
      if (resolved.status !== "resolved") continue
      if (isNativeOrWrapMint(
        resolved.identity.tokenAddress,
        resolved.identity.symbolDisplay ?? candidate.symbol,
      )) continue
      const hash = eventHash({
        kind: candidate.kind,
        chain: candidate.chain,
        token: candidate.tokenAddress,
        at: candidate.eventAt,
      })
      const entry: ResearchQueueEntry = {
        schema: 1,
        queueId: `rq-fomo-${candidate.kind}-${hash}`,
        subject,
        chain: resolved.identity.chain,
        tokenAddress: resolved.identity.tokenAddress,
        ...(resolved.identity.pairAddress ? { pairAddress: resolved.identity.pairAddress } : {}),
        ...(resolved.identity.symbolDisplay || candidate.symbol
          ? { symbolDisplay: (resolved.identity.symbolDisplay ?? candidate.symbol)!.slice(0, 32) }
          : {}),
        resolution: "resolved",
        priority: 50,
        firstSeen: args.fetchedAt,
        enqueuedAt: args.fetchedAt,
        enqueuedBy: `fomo:${candidate.kind}`,
        trigger: "social",
        expiresAt: expiryIso(args.fetchedAt, config.research.queue_expiry_days),
        provenance: [
          `fomo:${candidate.kind}:${candidate.chain}:${candidate.tokenAddress}:${hash}`,
        ],
        clusterCount: Math.max(1, new Set(candidate.handles).size),
        security: { status: "pending", flags: [] },
        status: "pending",
        reason: `fomo ${candidate.kind} signal`.slice(0, 280),
      }
      queue = enqueueResearch(queue, entry, config.research.daily_cap)
      enqueued += 1
      used += 1
      recentKeys.add(key)
    }
    await state.saveResearchQueue(queue)
    await saveEnqueueCount(args.archiveRoot, day, used)
  }

  return {
    snapshotNames,
    fypAuthors: [],
    discoverySightings: [],
    fcDiscoverySightings: [],
    fypPosts: [],
    fypCasts: [],
    postCount: candidates.length,
    skipAgent: true,
    collectionKind: "host-only",
    collectionStatus: config.fomo.shadow_mode
      ? `fomo-shadow candidates=${candidates.length}`
      : `fomo-enqueued=${enqueued}`,
  }
}
