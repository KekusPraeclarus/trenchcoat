import { createHash } from "node:crypto"
import { join } from "node:path"
import type { SnapshotWriter } from "../lib/snapshot.js"
import { loadConfig, type TrenchcoatConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { registerWalletCandidates } from "../wallets/discovery.js"
import { FomoWebClient, type FomoDataSource } from "../collectors/fomo/web-client.js"
import { providerGateAllowsSchedule, requireGatePass } from "../collectors/fomo/gates.js"
import { FomoClientError, type FomoLeaderboardEntry, type FomoTrader } from "../collectors/fomo/types.js"
import { pointInTimeSnapshot } from "../collectors/fomo/freshness.js"
import { fomoSessionExists } from "../collectors/social/fomo-auth.js"
import type { CollectionSummary } from "./collect.js"
import { upsertXSourceNominations } from "../sources/x-nominations.js"

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

function nominationLines(traders: readonly FomoTrader[]): string[] {
  const lines: string[] = []
  for (const trader of traders) {
    for (const wallet of trader.wallets) {
      lines.push(
        `handle=${trader.handle} chain=${wallet.chain} address=${wallet.address}`
          + (trader.trades !== undefined ? ` trades=${trader.trades}` : "")
          + (trader.winRate !== undefined ? ` winRate=${trader.winRate}` : "")
          + (trader.pnl !== undefined ? ` pnl=${trader.pnl}` : ""),
      )
    }
  }
  return lines
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

  const walletGate = requireGatePass(args.archiveRoot, "walletNomination")
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
      if (entry.xHandle || entry.wallets.length > 0) continue
      try {
        const stats = await client.getHandleStats(entry.handle)
        if (stats) byHandle.set(entry.handle, stats)
      } catch {
        // skip unavailable handles
      }
    }
    traders = rankTraders([...byHandle.values()])
      .slice(0, config.fomo.trader_sync.max_handles) as FomoLeaderboardEntry[]
  } catch (error) {
    const reason = error instanceof FomoClientError ? error.code : "upstream"
    const names = await writeSkip(args, `fomo-upstream code=${reason}`)
    if (!args.client) await client.close?.()
    return skipResult(names, "fomo-upstream-unavailable")
  } finally {
    if (!args.client) await client.close?.().catch(() => undefined)
  }

  const withWallets = traders.filter((trader) => trader.wallets.length > 0)
  const lines = nominationLines(withWallets)
  const snap = pointInTimeSnapshot(args.fetchedAt, args.fetchedAt)
  await args.writer.writeInbox(args.runId, "fomo-wallet-nominations", {
    source: "host.fomo-trader-sync",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: lines.map((text, index) => ({
      provenance: `${args.runId}:fomo:nomination:${index}`,
      text,
      ts: snap.ts,
      ageSec: snap.ageSec,
      freshnessTier: snap.freshnessTier,
      dedupeKey: createHash("sha256").update(text).digest("hex").slice(0, 32),
    })),
  })
  snapshotNames.push("fomo-wallet-nominations")

  // Shadow stays mutation-free: nominations are source-list adjacent state
  if (!config.fomo.shadow_mode && config.fomo.x_source_review.enabled) {
    const state = new StateStore(join(args.agentRoot, "state"))
    const next = upsertXSourceNominations(state.loadXSourceNominations(), {
      traders,
      nominatedAt: args.fetchedAt,
      maxPending: config.fomo.x_source_review.max_pending,
    })
    await state.saveXSourceNominations(next)
  }

  if (!walletGate.ok || withWallets.length === 0) {
    await args.writer.writeInbox(args.runId, "collection-status", {
      source: "host.fomo-trader-sync",
      fetchedAt: args.fetchedAt,
      trust: "untrusted-external",
      items: [{
        provenance: `${args.runId}:fomo:no-address`,
        text: `kind=skip reason=${walletGate.ok ? "fomo-no-address" : walletGate.reason} nominees=${withWallets.length}`,
        ts: args.fetchedAt,
        ageSec: 0,
        freshnessTier: "live",
      }],
    })
    snapshotNames.push("collection-status")
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
      collectionStatus: walletGate.ok ? "fomo-no-address" : walletGate.reason,
    }
  }

  const sightings = withWallets.flatMap((trader) => (
    trader.wallets.map((wallet) => ({
      chain: wallet.chain,
      address: wallet.address,
      origin: "fomo" as const,
    }))
  )).slice(0, config.fomo.trader_sync.max_wallet_candidates)

  if (!config.fomo.shadow_mode) {
    const state = new StateStore(join(args.agentRoot, "state"))
    const next = registerWalletCandidates(state.loadWallets(), sightings, args.fetchedAt)
    await state.saveWallets(next)
  }

  return {
    snapshotNames,
    fypAuthors: [],
    discoverySightings: [],
    fcDiscoverySightings: [],
    fypPosts: [],
    fypCasts: [],
    postCount: sightings.length,
    skipAgent: true,
    collectionKind: "host-only",
    collectionStatus: config.fomo.shadow_mode ? "fomo-shadow" : "fomo-nominated",
  }
}
