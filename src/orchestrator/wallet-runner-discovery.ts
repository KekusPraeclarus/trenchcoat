import { join } from "node:path"
import { ensureArchive, writeJsonRecord } from "../lib/archive.js"
import { loadConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { systemClock } from "../lib/clock.js"
import { sha256Json } from "../lib/canonical-json.js"
import { getChain, chainSlugFromProviderId } from "../lib/chains.js"
import {
  fetchGeckoNewPools,
  fetchClosedOhlcv,
  type FetchLike,
} from "../collectors/market/geckoterminal.js"
import { fetchDexScreenerPair } from "../collectors/market/providers.js"
import { discoverSolanaEarlyBuyers, isSolanaExecutableAccount } from "../collectors/wallets/helius-provider.js"
import {
  createEvmRunCache,
  discoverEvmEarlyBuyers,
  isEvmContractAddress,
  networkForChain,
  type EvmClientOptions,
} from "../collectors/wallets/evm-provider.js"
import { registerWalletCandidates } from "../wallets/discovery.js"
import {
  antiAutomationRejectReason,
  capNewCandidates,
  qualifyRunnerPool,
  rankEarlyRunnerBuyers,
  toNewPoolsSightings,
  walletsMeetingRecurrence,
  type RunnerBuyerEvent,
  type RunnerPoolCandidate,
  type SightingHistory,
} from "../wallets/runner-discovery.js"
import {
  sameSlotBuyRatio,
  upsertWalletExclusion,
} from "../wallets/exclusions.js"
import type {
  RunnerBuyerSighting,
  RunnerPoolRecord,
  WalletRunnersFile,
  WalletScanCursor,
} from "../contracts/schemas.js"

export type WalletRunnerDiscoveryReport = Readonly<{
  runId: string
  status: "completed" | "skipped" | "disabled" | "degraded"
  poolsSeen: number
  poolsQualified: number
  sightings: number
  candidatesAdded: number
  errors: readonly string[]
}>

const GECKO_NETWORK: Readonly<Record<string, string>> = {
  solana: "solana",
  ethereum: "eth",
  base: "base",
  robinhood: "robinhood",
}

function upsertCursor(
  cursors: readonly WalletScanCursor[],
  next: WalletScanCursor,
): WalletScanCursor[] {
  return [
    ...cursors.filter((c) => !(
      c.chain === next.chain && c.kind === next.kind && c.subject === next.subject
    )),
    next,
  ]
}

function quoteAssetsFor(chainSlug: string) {
  return getChain(chainSlug)?.quoteAssets ?? { acceptNative: true, allowlist: [] as readonly string[] }
}

function sixHourReturnAndVolume(candles: readonly Readonly<{
  startTime: number
  open: number
  close: number
  volume: number
}>[]): { return6h?: number; volume6hUsd?: number } {
  if (candles.length < 2) return {}
  // Prefer ~72 five-minute bars ≈ 6h; fall back to available span
  const newest = candles[candles.length - 1]!
  const target = newest.startTime - 6 * 3_600
  let oldest = candles[0]!
  for (const c of candles) {
    if (c.startTime <= target) oldest = c
  }
  if (oldest.open <= 0) return {}
  const volume6hUsd = candles
    .filter((c) => c.startTime >= oldest.startTime)
    .reduce((sum, c) => sum + c.volume, 0)
  return {
    return6h: (newest.close - oldest.open) / oldest.open,
    volume6hUsd,
  }
}

export async function runWalletRunnerDiscovery(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  runId: string
  dryRun?: boolean
  fetcher?: FetchLike
}>): Promise<WalletRunnerDiscoveryReport> {
  const config = loadConfig()
  const rd = config.wallets.runner_discovery
  if (!rd.enabled) {
    return {
      runId: args.runId,
      status: "disabled",
      poolsSeen: 0,
      poolsQualified: 0,
      sightings: 0,
      candidatesAdded: 0,
      errors: [],
    }
  }

  const fetcher = args.fetcher ?? fetch
  const heliusApiKey = process.env["HELIUS_API_KEY"]?.trim()
  const infuraApiKey = process.env["INFURA_API_KEY"]?.trim()
  const store = new StateStore(join(args.agentRoot, "state"))
  const archive = await ensureArchive(args.archiveRoot)
  const nowIso = systemClock.nowIso()
  const nowSec = Math.floor(Date.parse(nowIso) / 1_000)
  let runners = store.loadWalletRunners()
  let wallets = store.loadWallets()
  const errors: string[] = []
  let poolsSeen = 0
  let poolsQualified = 0
  const buyerEvents: RunnerBuyerEvent[] = []
  const qualifiedPools: RunnerPoolRecord[] = [...runners.pools]
  const sightingRows: RunnerBuyerSighting[] = [...runners.sightings]
  let cursors = [...runners.cursors]
  const evmCache = createEvmRunCache()

  const activeCandidates = wallets.wallets.filter((w) => w.status === "candidate").length
  if (activeCandidates >= rd.max_active_candidates) {
    const report: WalletRunnerDiscoveryReport = {
      runId: args.runId,
      status: "skipped",
      poolsSeen: 0,
      poolsQualified: 0,
      sightings: 0,
      candidatesAdded: 0,
      errors: [`active-candidates-cap:${activeCandidates}`],
    }
    await writeJsonRecord(join(archive.wallets, `${args.runId}-runner-discovery.json`), report as never)
    return report
  }

  for (const chain of rd.chains) {
    const network = GECKO_NETWORK[chain]
    if (!network) continue
    const chainMeta = getChain(chain)
    if (!chainMeta || chainMeta.walletTracking === "unsupported") continue
    try {
      const pools = await fetchGeckoNewPools(fetcher, { network })
      poolsSeen += pools.length
      for (const pool of pools) {
        const slug = chainSlugFromProviderId(pool.network) ?? chain
        if (slug !== chain) continue
        let tokenAddress = ""
        let pairAddress = pool.address
        let liquidityUsd: number | undefined
        try {
          const pairs = await fetchDexScreenerPair(fetcher, chainMeta.dexscreenerChainId, pool.address)
          const pair = pairs[0]
          if (pair) {
            tokenAddress = pair.baseToken.address
            pairAddress = pair.pairAddress
            liquidityUsd = pair.liquidityUsd
          }
        } catch (error) {
          errors.push(`pair:${pool.address}:${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        if (!tokenAddress) {
          errors.push(`pair:${pool.address}:no-base-token`)
          continue
        }

        let return6h: number | undefined
        let volume6hUsd: number | undefined
        try {
          const candles = await fetchClosedOhlcv(fetcher, {
            network,
            poolAddress: pool.address,
            aggregateMinutes: 5,
            limit: 80,
          }, nowSec)
          const metrics = sixHourReturnAndVolume(candles)
          return6h = metrics.return6h
          volume6hUsd = metrics.volume6hUsd
        } catch (error) {
          errors.push(`ohlcv:${pool.address}:${error instanceof Error ? error.message : String(error)}`)
          continue
        }

        const firstSeenAt = pool.createdAt ?? nowIso
        const runnerId = sha256Json({
          kind: "runner-pool",
          chain,
          pool: pool.address,
          token: tokenAddress,
        }).slice(0, 40).replace("sha256:", "rn_")

        const candidate: RunnerPoolCandidate = {
          runnerId,
          chain,
          poolAddress: pool.address,
          tokenAddress,
          pairAddress,
          firstSeenAt,
          ...(liquidityUsd !== undefined ? { liquidityUsd } : {}),
          ...(return6h !== undefined ? { return6h } : {}),
          ...(volume6hUsd !== undefined ? { volume6hUsd } : {}),
          securityHardFail: false,
        }
        const reject = qualifyRunnerPool(candidate, nowIso, {
          maxAgeHours: rd.max_age_hours,
          minLiquidityUsd: rd.min_liquidity_usd,
          minReturn6h: rd.min_return_6h,
          minVolume6hUsd: rd.min_volume_6h_usd,
        })
        const record: RunnerPoolRecord = {
          schema: 1,
          runnerId,
          chain: chain as RunnerPoolRecord["chain"],
          poolAddress: pool.address,
          tokenAddress,
          pairAddress,
          firstSeenAt,
          ...(reject
            ? { rejectedReason: reject }
            : { qualifiedAt: nowIso }),
          ...(liquidityUsd !== undefined ? { liquidityUsd } : {}),
          ...(return6h !== undefined ? { return6h } : {}),
          ...(volume6hUsd !== undefined ? { volume6hUsd } : {}),
        }
        const without = qualifiedPools.filter((p) => p.runnerId !== runnerId)
        without.push(record)
        qualifiedPools.length = 0
        qualifiedPools.push(...without.slice(-5_000))

        if (reject) continue
        poolsQualified += 1

        const quoteAssets = quoteAssetsFor(chain)
        try {
          if (chainMeta.walletTracking === "helius") {
            if (!heliusApiKey) {
              errors.push("missing HELIUS_API_KEY")
              continue
            }
            const result = await discoverSolanaEarlyBuyers({
              helius: { apiKey: heliusApiKey },
              tokenMint: tokenAddress,
              maxPages: 2,
              quoteAssets,
            })
            for (const action of result.actions) {
              buyerEvents.push({
                chain,
                tokenAddress,
                walletAddress: action.walletAddress,
                boughtAtIso: new Date(action.timestamp).toISOString(),
                providerEventId: action.providerEventId,
                runnerId,
                blockOrSlot: action.blockOrSlot,
              })
            }
            if (result.nextBefore) {
              cursors = upsertCursor(cursors, {
                schema: 1,
                chain: chain as WalletScanCursor["chain"],
                kind: "runner-discovery",
                subject: tokenAddress,
                cursor: result.nextBefore,
                updatedAt: nowIso,
              })
            }
          } else {
            const networkRpc = networkForChain(chain)
            const client: EvmClientOptions = {
              network: networkRpc,
              ...(networkRpc === "robinhood"
                ? {}
                : infuraApiKey
                  ? { apiKey: infuraApiKey }
                  : {}),
            }
            if (networkRpc !== "robinhood" && !client.apiKey) {
              errors.push("missing INFURA_API_KEY")
              continue
            }
            const result = await discoverEvmEarlyBuyers({
              client,
              tokenAddress,
              fromBlock: 0,
              maxBlocks: networkRpc === "robinhood" ? 400 : 2_000,
              quoteAssets,
              cache: evmCache,
            })
            for (const action of result.actions) {
              buyerEvents.push({
                chain,
                tokenAddress,
                walletAddress: action.walletAddress,
                boughtAtIso: new Date(action.timestamp).toISOString(),
                providerEventId: action.providerEventId,
                runnerId,
                blockOrSlot: action.blockOrSlot,
              })
            }
            cursors = upsertCursor(cursors, {
              schema: 1,
              chain: chain as WalletScanCursor["chain"],
              kind: "runner-discovery",
              subject: tokenAddress,
              cursor: String(result.nextFromBlock),
              updatedAt: nowIso,
            })
          }
        } catch (error) {
          errors.push(`buyers:${tokenAddress}:${error instanceof Error ? error.message : String(error)}`)
        }

        // Checkpoint after each qualified pool
        runners = {
          ...runners,
          pools: [...qualifiedPools],
          cursors,
          sightings: sightingRows,
        }
        if (!rd.shadow_mode && !args.dryRun) {
          await store.saveWalletRunners(runners)
        }
      }
    } catch (error) {
      errors.push(`pools:${chain}:${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const ranked = []
  for (const pool of qualifiedPools.filter((p) => p.qualifiedAt)) {
    const rankedBuyers = rankEarlyRunnerBuyers(buyerEvents, {
      runnerId: pool.runnerId,
      firstSeenAt: pool.firstSeenAt,
      windowMinutes: rd.buyer_window_minutes,
      topN: rd.top_buyers_per_runner,
    })
    if (rankedBuyers) ranked.push(rankedBuyers)
    for (const event of buyerEvents.filter((e) => e.runnerId === pool.runnerId)) {
      if (!rankedBuyers?.buyers.includes(event.walletAddress)) continue
      sightingRows.push({
        schema: 1,
        chain: event.chain as RunnerBuyerSighting["chain"],
        walletAddress: event.walletAddress,
        tokenAddress: event.tokenAddress,
        runnerId: event.runnerId,
        boughtAt: event.boughtAtIso,
        providerEventId: event.providerEventId,
        ...(event.blockOrSlot !== undefined ? { blockOrSlot: event.blockOrSlot } : {}),
      })
    }
    for (const [address, kind] of [
      [pool.poolAddress, "pool"],
      [pool.pairAddress, "pool"],
    ] as const) {
      wallets = upsertWalletExclusion(wallets, {
        chain: pool.chain,
        address,
        kind,
        observedAt: nowIso,
        detail: `runner:${pool.runnerId}`,
      })
    }
  }

  const historyMap = new Map<string, SightingHistory>()
  for (const s of sightingRows) {
    const key = `${s.chain}:${s.walletAddress.toLowerCase()}`
    const prev = historyMap.get(key)
    historyMap.set(key, {
      walletKey: key,
      runnerIds: [...new Set([...(prev?.runnerIds ?? []), s.runnerId])],
      lastSeenIso: !prev || Date.parse(s.boughtAt) > Date.parse(prev.lastSeenIso)
        ? s.boughtAt
        : prev.lastSeenIso,
    })
  }

  const eligibleKeys = new Set(walletsMeetingRecurrence([...historyMap.values()], {
    minRunners: rd.min_runners_for_candidate,
    lookbackDays: rd.sighting_lookback_days,
    nowIso,
  }))

  const heldPending = new Set<string>()
  const anti = rd.anti_automation
  const filteredRanked = []
  for (const row of ranked) {
    const buyers: string[] = []
    for (const address of row.buyers) {
      const key = `${row.chain}:${address.toLowerCase()}`
      if (!eligibleKeys.has(key)) continue
      if (
        address.toLowerCase() === row.tokenAddress.toLowerCase()
        || (wallets.exclusions ?? []).some((e) => (
          e.walletId.toLowerCase() === key && (e.kind === "pool" || e.kind === "router")
        ))
      ) {
        wallets = upsertWalletExclusion(wallets, {
          chain: row.chain as RunnerBuyerSighting["chain"],
          address,
          kind: "pool",
          observedAt: nowIso,
        })
        continue
      }

      if (row.chain === "solana" && heliusApiKey) {
        const executable = await isSolanaExecutableAccount({ apiKey: heliusApiKey }, address)
        if (executable === undefined) {
          heldPending.add(key)
          continue
        }
        if (executable) {
          wallets = upsertWalletExclusion(wallets, {
            chain: "solana",
            address,
            kind: "program",
            observedAt: nowIso,
          })
          continue
        }
      } else if (row.chain === "ethereum" || row.chain === "base" || row.chain === "robinhood") {
        const networkRpc = networkForChain(row.chain)
        const client: EvmClientOptions = {
          network: networkRpc,
          ...(networkRpc === "robinhood"
            ? {}
            : infuraApiKey
              ? { apiKey: infuraApiKey }
              : {}),
        }
        if (networkRpc !== "robinhood" && !client.apiKey) {
          heldPending.add(key)
          continue
        }
        const isContract = await isEvmContractAddress(client, address)
        if (isContract === undefined) {
          heldPending.add(key)
          continue
        }
        if (isContract) {
          wallets = upsertWalletExclusion(wallets, {
            chain: row.chain as RunnerBuyerSighting["chain"],
            address,
            kind: "contract",
            observedAt: nowIso,
          })
          continue
        }
      }

      const walletSightings = sightingRows.filter((s) => (
        s.chain === row.chain && s.walletAddress.toLowerCase() === address.toLowerCase()
      ))
      const hourAgo = Date.parse(nowIso) - 3_600_000
      const dayAgo = Date.parse(nowIso) - 86_400_000
      const buysLastHour = walletSightings.filter((s) => Date.parse(s.boughtAt) >= hourAgo).length
      const distinctTokensLastDay = new Set(
        walletSightings
          .filter((s) => Date.parse(s.boughtAt) >= dayAgo)
          .map((s) => s.tokenAddress.toLowerCase()),
      ).size
      const slotBlocks = walletSightings
        .map((s) => s.blockOrSlot)
        .filter((n): n is number => n !== undefined)
      const slotStats = sameSlotBuyRatio(slotBlocks)
      const reason = antiAutomationRejectReason({
        buysLastHour,
        distinctTokensLastDay,
        ...(slotStats.sample > 0
          ? { sameSlotBuyRatio: slotStats.ratio, sameSlotBuySample: slotStats.sample }
          : {}),
      }, {
        maxBuysPerHour: anti.max_buys_per_hour,
        maxDistinctTokensPerDay: anti.max_distinct_tokens_per_day,
        sameSlotRatio: anti.same_slot_ratio,
        sameSlotMinBuys: anti.same_slot_min_buys,
        sameFunderClusterMax: anti.same_funder_cluster_max,
      })
      if (reason !== undefined) continue
      buyers.push(address)
    }
    if (buyers.length > 0) filteredRanked.push({ ...row, buyers })
  }

  let candidatesAdded = 0
  const room = Math.max(0, rd.max_active_candidates - activeCandidates)
  const sightings = capNewCandidates(
    toNewPoolsSightings(filteredRanked),
    Math.min(rd.max_new_candidates_per_run, room),
  )

  if (!rd.shadow_mode && !args.dryRun) {
    if (sightings.length > 0) {
      const before = wallets.wallets.length
      wallets = registerWalletCandidates(wallets, sightings, nowIso)
      candidatesAdded = wallets.wallets.length - before
    }
    await store.saveWallets(wallets)
  }

  runners = {
    ...runners,
    pools: qualifiedPools.slice(-5_000),
    sightings: sightingRows.slice(-50_000),
    cursors,
  }
  if (!rd.shadow_mode && !args.dryRun) {
    await store.saveWalletRunners(runners)
  }

  const report: WalletRunnerDiscoveryReport = {
    runId: args.runId,
    status: errors.length > 0 || heldPending.size > 0 ? "degraded" : "completed",
    poolsSeen,
    poolsQualified,
    sightings: sightings.length,
    candidatesAdded,
    errors: [
      ...errors,
      ...(heldPending.size > 0 ? [`held-pending-account-kind:${heldPending.size}`] : []),
    ],
  }
  await writeJsonRecord(join(archive.wallets, `${args.runId}-runner-discovery.json`), {
    ...report,
    shadowMode: rd.shadow_mode,
    heldPending: [...heldPending].slice(0, 100),
  } as never)
  return report
}
