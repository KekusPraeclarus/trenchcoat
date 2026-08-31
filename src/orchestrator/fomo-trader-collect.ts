import { createHash } from "node:crypto"
import { join } from "node:path"
import type { SnapshotWriter } from "../lib/snapshot.js"
import { loadConfig, type TrenchcoatConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { FomoWebClient, type FomoDataSource } from "../collectors/fomo/web-client.js"
import { providerGateAllowsSchedule } from "../collectors/fomo/gates.js"
import { FomoClientError, type FomoLeaderboardEntry, type FomoTrader } from "../collectors/fomo/types.js"
import { pointInTimeSnapshot } from "../collectors/fomo/freshness.js"
import { fomoSessionExists } from "../collectors/social/fomo-auth.js"
import type { CollectionSummary } from "./collect.js"
import { upsertXSourceNominations } from "../sources/x-nominations.js"
import { applyFomoFollows, type FomoFollowFn } from "../sources/fomo-follows.js"
import { reportSessionAuthFailureCode } from "./auth-issue-notify.js"

function rankTraders(traders: readonly FomoTrader[]): FomoTrader[] {
  return [...traders].sort((a, b) => {
    const trades = (b.trades ?? 0) - (a.trades ?? 0)
    if (trades !== 0) return trades
    const win = (b.winRate ?? 0) - (a.winRate ?? 0)
    if (win !== 0) return win
    const pnl = (b.pnl ?? 0) - (a.pnl ?? 0)
    if (pnl !== 0) return pnl
    return a.handle.localeCompare(b.handle)
  })
}

/** Handle-ranked leaderboard lines — never chain addresses (Fomo profiles ≠ wallets) */
function leaderboardLines(traders: readonly FomoTrader[]): string[] {
  return traders.map((trader) => {
    let line = `handle=${trader.handle}`
    if (trader.xHandle) line += ` xHandle=${trader.xHandle}`
    if (trader.trades !== undefined) line += ` trades=${trader.trades}`
    if (trader.winRate !== undefined) line += ` winRate=${trader.winRate}`
    if (trader.pnl !== undefined) line += ` pnl=${trader.pnl}`
    return line
  })
}

function skipResult(
  snapshotNames: string[],
  status: string,
): CollectionSummary {
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
  await args.writer.writeInbox(args.runId, "collection-status", {
    source: "host.fomo-trader-sync",
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

export async function collectFomoTraderSync(args: Readonly<{
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  agentRoot: string
  archiveRoot: string
  client?: FomoDataSource
  /** Test injection — production callers omit and use loadConfig() */
  config?: TrenchcoatConfig
  follow?: FomoFollowFn
}>): Promise<CollectionSummary> {
  const config = args.config ?? loadConfig()
  const snapshotNames: string[] = []

  if (!config.fomo.enabled || !config.fomo.trader_sync.enabled) {
    return skipResult(await writeSkip(args, "fomo-disabled"), "fomo-disabled")
  }
  if (!providerGateAllowsSchedule(args.archiveRoot)) {
    return skipResult(await writeSkip(args, "fomo-provider-gate"), "fomo-provider-gate")
  }
  // Injected clients are for fixtures/tests; live scrape still requires burner session
  if (!args.client && !fomoSessionExists()) {
    return skipResult(await writeSkip(args, "fomo-missing-session"), "fomo-missing-session")
  }

  const client = args.client ?? new FomoWebClient({
    archiveRoot: args.archiveRoot,
    dailyNavigationBudget: config.fomo.daily_navigation_budget,
    minDelayMs: config.fomo.min_delay_ms,
    maxDelayMs: config.fomo.max_delay_ms,
    navigationTimeoutMs: config.fomo.navigation_timeout_ms,
    maxPayloadBytes: config.fomo.max_payload_bytes,
  })

  let traders: FomoLeaderboardEntry[] = []
  try {
    const leaderboard = await client.getLeaderboard({ timeframe: "7d", limit: 50 })
    const byHandle = new Map<string, FomoLeaderboardEntry>()
    for (const trader of leaderboard) byHandle.set(trader.handle, trader)
    for (const entry of leaderboard.slice(0, config.fomo.trader_sync.max_profile_pages)) {
      if (entry.xHandle) continue
      try {
        const stats = await client.getHandleStats(entry.handle)
        if (!stats?.xHandle) continue
        byHandle.set(entry.handle, {
          ...entry,
          xHandle: stats.xHandle,
          ...(stats.xProfileUrl ? { xProfileUrl: stats.xProfileUrl } : {}),
        })
      } catch {
        // skip unavailable handles
      }
    }
    traders = rankTraders([...byHandle.values()])
      .slice(0, config.fomo.trader_sync.max_handles) as FomoLeaderboardEntry[]
  } catch (error) {
    const reason = error instanceof FomoClientError ? error.code : "upstream"
    await reportSessionAuthFailureCode({
      source: "fomo",
      code: reason,
      at: args.fetchedAt,
    }).catch(() => undefined)
    const names = await writeSkip(args, `fomo-upstream code=${reason}`)
    if (!args.client) await client.close?.()
    return skipResult(names, "fomo-upstream-unavailable")
  } finally {
    if (!args.client) await client.close?.().catch(() => undefined)
  }

  const lines = leaderboardLines(traders)
  const snap = pointInTimeSnapshot(args.fetchedAt, args.fetchedAt)
  await args.writer.writeInbox(args.runId, "fomo-leaderboard", {
    source: "host.fomo-trader-sync",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: lines.map((text, index) => ({
      provenance: `${args.runId}:fomo:leaderboard:${index}`,
      text,
      ts: snap.ts,
      ageSec: snap.ageSec,
      freshnessTier: snap.freshnessTier,
      dedupeKey: createHash("sha256").update(text).digest("hex").slice(0, 32),
    })),
  })
  snapshotNames.push("fomo-leaderboard")

  // Shadow stays mutation-free. Live may follow FOMO handles and upsert
  // linked-X nominations only. Never wallets.
  if (!config.fomo.shadow_mode) {
    const state = new StateStore(join(args.agentRoot, "state"))
    if (config.fomo.follows.enabled) {
      const applied = await applyFomoFollows({
        file: state.loadFomoFollows(),
        traders,
        nowIso: args.fetchedAt,
        maxFollowing: config.fomo.follows.max_following,
        maxFollowsPerRun: config.fomo.follows.max_follows_per_run,
        ...(args.follow ? { follow: args.follow } : {}),
      })
      await state.saveFomoFollows(applied.file)
    }
    if (config.fomo.x_source_review.enabled) {
      const next = upsertXSourceNominations(state.loadXSourceNominations(), {
        traders,
        nominatedAt: args.fetchedAt,
        maxPending: config.fomo.x_source_review.max_pending,
        requireProfileLink: true,
      })
      await state.saveXSourceNominations(next)
    }
  }

  return {
    snapshotNames,
    fypAuthors: [],
    discoverySightings: [],
    fcDiscoverySightings: [],
    fypPosts: [],
    fypCasts: [],
    postCount: lines.length,
    skipAgent: true,
    collectionKind: "host-only",
    collectionStatus: config.fomo.shadow_mode ? "fomo-shadow" : "fomo-leaderboard",
  }
}
