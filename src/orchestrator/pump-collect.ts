import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { SnapshotWriter } from "../lib/snapshot.js"
import { loadConfig, type TrenchcoatConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { enqueueResearch } from "../lib/research-queue.js"
import type { PumpCallEvent, ResearchQueueEntry } from "../contracts/schemas.js"
import { PumpWebClient } from "../collectors/pump/web-client.js"
import { providerGateAllowsSchedule } from "../collectors/pump/gates.js"
import { PumpClientError, type PumpDataSource, type PumpFeedItem, type PumpFeedTab } from "../collectors/pump/types.js"
import { pumpSessionExists } from "../collectors/social/pump-auth.js"
import { resolveResearchSubject } from "./research-collect.js"
import type { CollectionSummary } from "./collect.js"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { isNativeOrWrapMint } from "../lib/native-mints.js"
import { writeJsonRecord, ensureArchive } from "../lib/archive.js"
import { writePumpFypEligibleSnapshot } from "./pump-fyp-eligible.js"
import {
  advancePumpScanCursor,
  loadPumpScanCursors,
  pumpScanCursorsPath,
} from "./pump-scan-cursors.js"
import { SNAPSHOT_MAX_ITEMS } from "../contracts/schemas.js"

function expiryIso(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) + days * 86_400_000).toISOString()
}

function eventHash(parts: Readonly<Record<string, string | number | undefined>>): string {
  const stable = Object.keys(parts).sort().map((key) => `${key}=${parts[key] ?? ""}`).join("|")
  return createHash("sha256").update(stable).digest("hex").slice(0, 24)
}

function enqueueReceiptPath(archiveRoot: string, day: string): string {
  return join(archiveRoot, "provider-usage", "pump", `enqueues-${day}.json`)
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
  await writeAtomicFile(
    enqueueReceiptPath(archiveRoot, day),
    `${JSON.stringify({ schema: 1, day, count }, null, 2)}\n`,
  )
}

function skipResult(snapshotNames: string[], status: string): CollectionSummary {
  return {
    snapshotNames,
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
  await args.writer.writeInbox(args.runId, "pump-scan-collection-status", {
    source: "host.pump-scan",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:pump:${reason}`,
      text: `kind=skip reason=${reason}`,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
    }],
  })
  return ["pump-scan-collection-status"]
}

function itemLine(item: PumpFeedItem): string {
  return `itemId=${item.itemId} author=${item.author}`
    + (item.mint ? ` mint=${item.mint}` : "")
    + ` tab=${item.tab}`
}

async function writeFeedSnapshot(
  args: Readonly<{ runId: string, writer: SnapshotWriter, fetchedAt: string }>,
  name: string,
  items: readonly PumpFeedItem[],
): Promise<void> {
  await args.writer.writeInbox(args.runId, name, {
    source: `host.pump-scan.${name}`,
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: items.slice(0, SNAPSHOT_MAX_ITEMS).map((item) => ({
      provenance: `${args.runId}:pump:${item.tab}:${item.itemId}`,
      text: itemLine(item),
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live" as const,
      dedupeKey: item.itemId,
    })),
  })
}

export async function collectPumpScan(args: Readonly<{
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  agentRoot: string
  archiveRoot: string
  client?: PumpDataSource
  sessionExists?: boolean
  config?: TrenchcoatConfig
  cursorsPath?: string
  fetcher?: typeof fetch
}>): Promise<CollectionSummary> {
  const config = args.config ?? loadConfig()
  const snapshotNames: string[] = []

  if (!config.pump.enabled) {
    return skipResult(await writeSkip(args, "pump-disabled"), "pump-disabled")
  }
  if (!providerGateAllowsSchedule(args.archiveRoot)) {
    return skipResult(await writeSkip(args, "pump-provider-gate"), "pump-provider-gate")
  }
  const sessionOk = args.sessionExists ?? pumpSessionExists()
  if (!sessionOk) {
    return skipResult(await writeSkip(args, "pump-missing-session"), "pump-missing-session")
  }

  const client = args.client ?? new PumpWebClient({
    archiveRoot: args.archiveRoot,
    dailyNavigationBudget: config.pump.daily_navigation_budget,
    minDelayMs: config.pump.min_delay_ms,
    maxDelayMs: config.pump.max_delay_ms,
    navigationTimeoutMs: config.pump.navigation_timeout_ms,
    maxPayloadBytes: config.pump.max_payload_bytes,
    maxPagesPerFeed: config.pump.max_pages_per_feed,
  })
  const ownedClient = args.client === undefined
  const state = new StateStore(join(args.agentRoot, "state"))
  const engagement = state.loadPumpEngagement()
  const cursorsPath = args.cursorsPath ?? pumpScanCursorsPath()
  const cursors = loadPumpScanCursors(cursorsPath)

  const feeds: Record<PumpFeedTab, PumpFeedItem[]> = {
    fyp: [],
    top: [],
    news: [],
    following: [],
  }

  try {
    for (const tab of ["fyp", "top", "news"] as const) {
      const cursor = cursors.tabs[tab]?.lastItemId
      const items = await client.readFeed({
        tab,
        ...(cursor ? { cursor } : {}),
        maxPages: config.pump.max_pages_per_feed,
      })
      feeds[tab] = [...items]
      await writeFeedSnapshot(args, `pump-${tab}`, items)
      snapshotNames.push(`pump-${tab}`)
      const last = items.at(-1)
      if (last) {
        await advancePumpScanCursor({
          cursorsPath,
          tab,
          lastItemId: last.itemId,
          nowIso: args.fetchedAt,
        })
      }
    }

    if (engagement.followedHandles.length >= config.pump.following_min_follows) {
      const cursor = cursors.tabs["following"]?.lastItemId
      const items = await client.readFeed({
        tab: "following",
        ...(cursor ? { cursor } : {}),
        maxPages: config.pump.max_pages_per_feed,
      })
      feeds.following = [...items]
      await writeFeedSnapshot(args, "pump-following", items)
      snapshotNames.push("pump-following")
      const last = items.at(-1)
      if (last) {
        await advancePumpScanCursor({
          cursorsPath,
          tab: "following",
          lastItemId: last.itemId,
          nowIso: args.fetchedAt,
        })
      }
    } else {
      await args.writer.writeInbox(args.runId, "pump-scan-collection-status", {
        source: "host.pump-scan",
        fetchedAt: args.fetchedAt,
        trust: "untrusted-external",
        items: [{
          provenance: `${args.runId}:pump:following-skipped-below-min`,
          text: `kind=status reason=following-skipped-below-min follows=${engagement.followedHandles.length}`,
          ts: args.fetchedAt,
          ageSec: 0,
          freshnessTier: "live",
        }],
      })
      snapshotNames.push("pump-scan-collection-status")
    }

    if (config.pump.leaderboard.enabled) {
      const entries = await client.readLeaderboard({
        maxHandles: config.pump.leaderboard.max_handles,
      })
      await args.writer.writeInbox(args.runId, "pump-leaderboard", {
        source: "host.pump-scan.leaderboard",
        fetchedAt: args.fetchedAt,
        trust: "untrusted-external",
        items: entries.map((entry) => ({
          provenance: `${args.runId}:pump:leaderboard:${entry.handle}`,
          text: `handle=${entry.handle} rank=${entry.rank}`,
          ts: args.fetchedAt,
          ageSec: 0,
          freshnessTier: "live" as const,
        })),
      })
      snapshotNames.push("pump-leaderboard")
    }

    const followed = new Set(engagement.followedHandles)
    const authors = [...feeds.fyp, ...feeds.top, ...feeds.news]
      .map((item) => item.author)
      .filter((handle, index, all) => all.indexOf(handle) === index && !followed.has(handle))
      .slice(0, config.pump.max_profile_chart_pages)

    const callEvents: PumpCallEvent[] = []
    const callerLines: string[] = []
    for (const handle of authors) {
      const profile = await client.readCallerProfile(handle)
      for (const call of profile.calls) {
        callEvents.push({
          schema: 1,
          callerId: call.callerId,
          chain: call.chain,
          tokenAddress: call.tokenAddress,
          calledAt: call.calledAt,
          provenance: `${args.runId}:pump:caller:${handle}`,
          ...(call.itemId ? { itemId: call.itemId } : {}),
        })
        callerLines.push(
          `author=${handle} mint=${call.tokenAddress} chain=${call.chain} at=${call.calledAt}`,
        )
        if (client.captureCallChart) {
          const png = await client.captureCallChart(handle, call.tokenAddress)
          if (png) {
            const safeCaller = handle.replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 32)
            const safeMint = call.tokenAddress.slice(0, 12)
            await args.writer.writeChartPng(
              args.runId,
              `pump-chart-${safeCaller}-${safeMint}.png`,
              png,
            )
          }
        }
      }
    }
    if (callerLines.length > 0) {
      await args.writer.writeInbox(args.runId, "pump-caller-calls", {
        source: "host.pump-scan.caller-calls",
        fetchedAt: args.fetchedAt,
        trust: "untrusted-external",
        items: callerLines.slice(0, SNAPSHOT_MAX_ITEMS).map((text, index) => ({
          provenance: `${args.runId}:pump:caller-calls:${index}`,
          text,
          ts: args.fetchedAt,
          ageSec: 0,
          freshnessTier: "live" as const,
        })),
      })
      snapshotNames.push("pump-caller-calls")
    }

    const eligibleSource = [...feeds.fyp, ...feeds.top, ...feeds.news]
    const seenEligible = new Set<string>()
    const eligibleItems: Array<{ itemId: string, author: string }> = []
    for (const item of eligibleSource) {
      if (seenEligible.has(item.itemId)) continue
      seenEligible.add(item.itemId)
      eligibleItems.push({ itemId: item.itemId, author: item.author })
    }
    await writePumpFypEligibleSnapshot({
      writer: args.writer,
      runId: args.runId,
      fetchedAt: args.fetchedAt,
      items: eligibleItems,
    })
    snapshotNames.push("pump-fyp-eligible")

    if (callEvents.length > 0) {
      const archive = await ensureArchive(args.archiveRoot)
      await writeJsonRecord(
        join(archive.outcomes, `pump-call-${args.runId}.json`),
        { schema: 1, runId: args.runId, events: callEvents } as never,
      )
    }

    if (!config.pump.shadow_mode) {
      await enqueuePumpResearch({
        agentRoot: args.agentRoot,
        archiveRoot: args.archiveRoot,
        fetchedAt: args.fetchedAt,
        runId: args.runId,
        config,
        following: feeds.following,
        top: feeds.top,
        ...(args.fetcher ? { fetcher: args.fetcher } : {}),
      })
    }
  } catch (error) {
    if (ownedClient) await client.close().catch(() => undefined)
    const reason = error instanceof PumpClientError ? error.code : "upstream"
    return skipResult(
      await writeSkip(args, `pump-upstream code=${reason}`),
      "pump-upstream-unavailable",
    )
  }

  if (ownedClient) await client.close().catch(() => undefined)

  return {
    snapshotNames,
    fypAuthors: [...new Set([...feeds.fyp, ...feeds.top, ...feeds.news].map((i) => i.author))],
    discoverySightings: [],
    fcDiscoverySightings: [],
    fypPosts: [],
    fypCasts: [],
    postCount: feeds.fyp.length + feeds.top.length + feeds.news.length,
    skipAgent: false,
    collectionKind: "external",
    collectionStatus: "completed",
  }
}

export async function enqueuePumpResearch(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  fetchedAt: string
  runId: string
  config: TrenchcoatConfig
  following: readonly PumpFeedItem[]
  top: readonly PumpFeedItem[]
  fetcher?: typeof fetch
}>): Promise<void> {
  const day = args.fetchedAt.slice(0, 10)
  let used = await loadEnqueueCount(args.archiveRoot, day)
  const cap = args.config.pump.research.max_enqueues_per_day
  if (used >= cap) return
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

  const ordered: Array<{ item: PumpFeedItem, source: "following" | "top" }> = [
    ...args.following.map((item) => ({ item, source: "following" as const })),
    ...args.top.map((item) => ({ item, source: "top" as const })),
  ]
  const seen = new Set<string>()

  for (const { item, source } of ordered) {
    if (used >= cap) break
    if (!item.mint || !item.chain) continue
    if (isNativeOrWrapMint(item.mint)) continue
    const key = `${item.chain}:${item.mint}`
    if (seen.has(key) || watchlistKeys.has(key) || recentKeys.has(key)) continue
    seen.add(key)
    const resolved = await resolveResearchSubject(
      { subject: key },
      args.fetcher ?? globalThis.fetch,
    )
    if (resolved.status !== "resolved") continue
    if (isNativeOrWrapMint(resolved.identity.tokenAddress)) continue
    const hash = eventHash({
      chain: resolved.identity.chain,
      token: resolved.identity.tokenAddress,
      at: args.fetchedAt,
      source,
    })
    const entry: ResearchQueueEntry = {
      schema: 1,
      queueId: `rq-pump-${source}-${hash}`,
      subject: key,
      chain: resolved.identity.chain,
      tokenAddress: resolved.identity.tokenAddress,
      ...(resolved.identity.pairAddress ? { pairAddress: resolved.identity.pairAddress } : {}),
      ...(resolved.identity.symbolDisplay
        ? { symbolDisplay: resolved.identity.symbolDisplay.slice(0, 32) }
        : {}),
      resolution: "resolved",
      priority: source === "following" ? 40 : 55,
      firstSeen: args.fetchedAt,
      enqueuedAt: args.fetchedAt,
      enqueuedBy: `pump:${source}`,
      trigger: "social",
      expiresAt: expiryIso(args.fetchedAt, args.config.research.queue_expiry_days),
      provenance: [
        `pump:${source}:${resolved.identity.chain}:${resolved.identity.tokenAddress}:${hash}`,
      ],
      clusterCount: 1,
      security: { status: "pending", flags: [] },
      status: "pending",
      reason: `pump ${source} mint`.slice(0, 280),
    }
    queue = enqueueResearch(queue, entry, args.config.research.daily_cap)
    used += 1
    recentKeys.add(`${resolved.identity.chain}:${resolved.identity.tokenAddress}`)
  }
  await state.saveResearchQueue(queue)
  await saveEnqueueCount(args.archiveRoot, day, used)
}
