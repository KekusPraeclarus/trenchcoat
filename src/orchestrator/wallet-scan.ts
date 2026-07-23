import { join } from "node:path"
import { ensureArchive, writeJsonRecord } from "../lib/archive.js"
import { getChain } from "../lib/chains.js"
import { loadConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { systemClock } from "../lib/clock.js"
import { sha256Json } from "../lib/canonical-json.js"
import { withAgentWorkspaceLock } from "../lib/lock.js"
import { listSolanaWalletActions } from "../collectors/wallets/helius-provider.js"
import {
  createEvmRunCache,
  listEvmWalletActions,
  networkForChain,
  type EvmClientOptions,
} from "../collectors/wallets/evm-provider.js"
import { eligibleWalletTrades } from "../wallets/providers.js"
import type { WalletBuyOutcome, WalletScanCursor, WalletRecord } from "../contracts/schemas.js"
import { runWalletConvergence } from "./wallet-convergence.js"

export type WalletScanSkippedReason =
  | "wallet-state-empty"
  | "no-eligible-wallet-status"
  | "no-wallets-for-family"
  | "dry-collect"

export type WalletScanReport = Readonly<{
  runId: string
  family: "solana" | "evm"
  status: "completed" | "skipped" | "degraded"
  skippedReason?: WalletScanSkippedReason
  totalWallets: number
  eligibleStatusCount: number
  eligibleFamilyCount: number
  walletsSelected: number
  walletsScanned: number
  actionsRecorded: number
  cursorsUpdated: number
  convergenceAlerts?: number
  convergenceEnqueues?: number
  errors: readonly string[]
}>

const BACKFILL_MS = 30 * 86_400_000

function upsertCursor(
  cursors: readonly WalletScanCursor[],
  next: WalletScanCursor,
): WalletScanCursor[] {
  const filtered = cursors.filter((c) => !(
    c.chain === next.chain && c.kind === next.kind && c.subject === next.subject
  ))
  return [...filtered, next]
}

function findCursor(
  cursors: readonly WalletScanCursor[],
  chain: string,
  kind: WalletScanCursor["kind"],
  subject: string,
): WalletScanCursor | undefined {
  return cursors.find((c) => c.chain === chain && c.kind === kind && c.subject === subject)
}

function outcomeFromAction(args: Readonly<{
  wallet: WalletRecord
  chain: WalletBuyOutcome["chain"]
  action: Readonly<{
    walletAddress: string
    tokenAddress: string
    timestamp: number
    finalized: boolean
    removed?: boolean
    priceable: boolean
    providerEventId: string
    classification: "swap-buy" | "swap-sell" | "unknown"
    tokenReceivedRaw?: string
    tokenSoldRaw?: string
    quoteSpent?: Readonly<{ asset: string; amountRaw: string }>
  }>
}>): WalletBuyOutcome {
  const boughtAt = new Date(
    args.action.timestamp > 1_000_000_000_000
      ? args.action.timestamp
      : args.action.timestamp * 1_000,
  ).toISOString()
  const side = args.action.classification === "swap-sell" ? "sell" as const : "buy" as const
  const eventId = sha256Json({
    walletId: args.wallet.walletId,
    token: args.action.tokenAddress,
    providerEventId: args.action.providerEventId,
    side,
    ts: boughtAt,
  }).slice("sha256:".length).slice(0, 32)
  const amountRaw = side === "sell"
    ? args.action.tokenSoldRaw
    : args.action.tokenReceivedRaw
  return {
    schema: 1,
    eventId: `wb_${eventId}`,
    walletId: args.wallet.walletId,
    chain: args.chain,
    tokenAddress: args.action.tokenAddress,
    boughtAt,
    side,
    finalized: args.action.finalized,
    removed: Boolean(args.action.removed),
    priceable: args.action.priceable,
    rug: false,
    providerEventId: args.action.providerEventId,
    walletStatusAtEvent: args.wallet.status,
    ...(amountRaw ? { tokenAmountRaw: amountRaw } : {}),
    ...(args.action.quoteSpent ? { quoteAmountRaw: args.action.quoteSpent.amountRaw } : {}),
  }
}

function quoteAssetsFor(chainSlug: string) {
  const chain = getChain(chainSlug)
  return chain?.quoteAssets ?? { acceptNative: true, allowlist: [] as readonly string[] }
}

function cursorFreshnessMs(
  cursors: readonly WalletScanCursor[],
  wallet: WalletRecord,
): number {
  const tip = findCursor(cursors, wallet.chain, "wallet-scan-tip", wallet.address)
  const backfill = findCursor(cursors, wallet.chain, "wallet-scan-backfill", wallet.address)
    ?? findCursor(cursors, wallet.chain, "wallet-scan", wallet.address)
  return Math.max(
    tip ? Date.parse(tip.updatedAt) || 0 : 0,
    backfill ? Date.parse(backfill.updatedAt) || 0 : 0,
  )
}

/** Oldest cursors first so backfill progresses under a per-run cap */
export function selectWalletsForScan(
  trackable: readonly WalletRecord[],
  cursors: readonly WalletScanCursor[],
  maxPerRun: number,
): WalletRecord[] {
  const capped = Math.max(1, maxPerRun)
  return [...trackable]
    .sort((a, b) => {
      const delta = cursorFreshnessMs(cursors, a) - cursorFreshnessMs(cursors, b)
      if (delta !== 0) return delta
      return a.walletId.localeCompare(b.walletId)
    })
    .slice(0, capped)
}

type ScanWalletResult = Readonly<{
  walletId: string
  outcomes: readonly WalletBuyOutcome[]
  cursorUpdates: readonly WalletScanCursor[]
  error?: string
}>

async function fetchWalletActions(args: Readonly<{
  wallet: WalletRecord
  cursors: readonly WalletScanCursor[]
  family: "solana" | "evm"
  nowIso: string
  nowMs: number
  heliusApiKey: string | undefined
  infuraApiKey: string | undefined
  evmCache: ReturnType<typeof createEvmRunCache>
}>): Promise<ScanWalletResult> {
  const { wallet } = args
  const chain = getChain(wallet.chain)
  if (!chain) {
    return { walletId: wallet.walletId, outcomes: [], cursorUpdates: [], error: "unknown chain" }
  }
  const quoteAssets = quoteAssetsFor(wallet.chain)
  const needsBackfill = wallet.status === "candidate"
  const outcomes: WalletBuyOutcome[] = []
  const cursorUpdates: WalletScanCursor[] = []

  try {
    if (chain.walletTracking === "helius") {
      if (!args.heliusApiKey) {
        return {
          walletId: wallet.walletId,
          outcomes: [],
          cursorUpdates: [],
          error: "missing HELIUS_API_KEY",
        }
      }
      const tip = findCursor(args.cursors, wallet.chain, "wallet-scan-tip", wallet.address)
      const backfill = findCursor(args.cursors, wallet.chain, "wallet-scan-backfill", wallet.address)
        ?? findCursor(args.cursors, wallet.chain, "wallet-scan", wallet.address)
      const fromTimestamp = needsBackfill
        ? Math.min(Date.parse(wallet.addedAt), args.nowMs - BACKFILL_MS)
        : Date.parse(wallet.addedAt)
      const result = await listSolanaWalletActions({
        helius: { apiKey: args.heliusApiKey },
        walletAddress: wallet.address,
        fromTimestamp,
        ...(tip && !needsBackfill ? { until: tip.cursor } : {}),
        ...(backfill && needsBackfill ? { before: backfill.cursor } : {}),
        quoteAssets,
      })
      for (const action of eligibleWalletTrades(result.actions)) {
        outcomes.push(outcomeFromAction({ wallet, chain: wallet.chain, action }))
      }
      if (result.tipSignature) {
        cursorUpdates.push({
          schema: 1,
          chain: wallet.chain,
          kind: "wallet-scan-tip",
          subject: wallet.address,
          cursor: result.tipSignature,
          updatedAt: args.nowIso,
        })
      }
      if (result.nextBefore) {
        cursorUpdates.push({
          schema: 1,
          chain: wallet.chain,
          kind: needsBackfill ? "wallet-scan-backfill" : "wallet-scan",
          subject: wallet.address,
          cursor: result.nextBefore,
          updatedAt: args.nowIso,
        })
      }
    } else {
      const network = networkForChain(wallet.chain)
      const client: EvmClientOptions = {
        network,
        ...(network === "robinhood"
          ? {}
          : args.infuraApiKey
            ? { apiKey: args.infuraApiKey }
            : {}),
      }
      if (network !== "robinhood" && !client.apiKey) {
        return {
          walletId: wallet.walletId,
          outcomes: [],
          cursorUpdates: [],
          error: "missing INFURA_API_KEY",
        }
      }
      const existing = findCursor(args.cursors, wallet.chain, "wallet-scan", wallet.address)
        ?? findCursor(args.cursors, wallet.chain, "wallet-scan-backfill", wallet.address)
      const fromBlock = existing ? Number(existing.cursor) : 0
      const result = await listEvmWalletActions({
        client,
        walletAddress: wallet.address,
        fromBlock,
        maxBlocks: network === "robinhood" ? 400 : 2_000,
        quoteAssets,
        cache: args.evmCache,
      })
      for (const action of eligibleWalletTrades(result.actions)) {
        outcomes.push(outcomeFromAction({ wallet, chain: wallet.chain, action }))
      }
      cursorUpdates.push({
        schema: 1,
        chain: wallet.chain,
        kind: "wallet-scan",
        subject: wallet.address,
        cursor: String(result.nextFromBlock),
        updatedAt: args.nowIso,
      })
    }
  } catch (error) {
    return {
      walletId: wallet.walletId,
      outcomes: [],
      cursorUpdates: [],
      error: `${wallet.walletId}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return { walletId: wallet.walletId, outcomes, cursorUpdates }
}

function skippedReport(args: Readonly<{
  runId: string
  family: "solana" | "evm"
  reason: WalletScanSkippedReason
  totalWallets: number
  eligibleStatusCount: number
  eligibleFamilyCount: number
}>): WalletScanReport {
  return {
    runId: args.runId,
    family: args.family,
    status: "skipped",
    skippedReason: args.reason,
    totalWallets: args.totalWallets,
    eligibleStatusCount: args.eligibleStatusCount,
    eligibleFamilyCount: args.eligibleFamilyCount,
    walletsSelected: 0,
    walletsScanned: 0,
    actionsRecorded: 0,
    cursorsUpdated: 0,
    errors: [],
  }
}

/**
 * Host wallet scan: provider I/O runs unlocked; cursors / convergence commit under a
 * brief agent lock so settle/review are not starved (ADR 027).
 */
export async function runWalletScan(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  runId: string
  family: "solana" | "evm"
  dryRun?: boolean
  blockExternalEffects?: boolean
  maxWalletsPerScan?: number
}>): Promise<WalletScanReport> {
  const heliusApiKey = process.env["HELIUS_API_KEY"]?.trim()
  const infuraApiKey = process.env["INFURA_API_KEY"]?.trim()
  const store = new StateStore(join(args.agentRoot, "state"))
  const archive = await ensureArchive(args.archiveRoot)
  const nowIso = systemClock.nowIso()
  const file = store.loadWallets()
  const totalWallets = file.wallets.length
  const statusEligible = file.wallets.filter((wallet) => (
    wallet.status === "candidate"
    || wallet.status === "tracking-probation"
    || wallet.status === "tracking"
  ))
  const trackable = statusEligible.filter((wallet) => {
    const chain = getChain(wallet.chain)
    if (!chain || chain.walletTracking === "unsupported") return false
    if (args.family === "solana") return chain.walletTracking === "helius"
    return chain.walletTracking === "infura" || chain.walletTracking === "robinhood-public"
  })
  const maxPerRun = args.maxWalletsPerScan
    ?? loadConfig().wallets.max_wallets_per_scan

  const writeReport = async (report: WalletScanReport): Promise<WalletScanReport> => {
    await writeJsonRecord(join(archive.wallets, `${args.runId}-scan-report.json`), report as never)
    return report
  }

  if (args.dryRun) {
    return writeReport(skippedReport({
      runId: args.runId,
      family: args.family,
      reason: "dry-collect",
      totalWallets,
      eligibleStatusCount: statusEligible.length,
      eligibleFamilyCount: trackable.length,
    }))
  }

  if (totalWallets === 0) {
    return writeReport(skippedReport({
      runId: args.runId,
      family: args.family,
      reason: "wallet-state-empty",
      totalWallets: 0,
      eligibleStatusCount: 0,
      eligibleFamilyCount: 0,
    }))
  }

  if (statusEligible.length === 0) {
    return writeReport(skippedReport({
      runId: args.runId,
      family: args.family,
      reason: "no-eligible-wallet-status",
      totalWallets,
      eligibleStatusCount: 0,
      eligibleFamilyCount: 0,
    }))
  }

  if (trackable.length === 0) {
    return writeReport(skippedReport({
      runId: args.runId,
      family: args.family,
      reason: "no-wallets-for-family",
      totalWallets,
      eligibleStatusCount: statusEligible.length,
      eligibleFamilyCount: 0,
    }))
  }

  const selected = selectWalletsForScan(trackable, file.cursors, maxPerRun)
  const snapshotCursors = [...file.cursors]
  const errors: string[] = []
  const outcomes: WalletBuyOutcome[] = []
  const cursorUpdates: WalletScanCursor[] = []
  const evmCache = createEvmRunCache()
  const nowMs = Date.parse(nowIso)

  for (const wallet of selected) {
    const result = await fetchWalletActions({
      wallet,
      cursors: snapshotCursors,
      family: args.family,
      nowIso,
      nowMs,
      heliusApiKey,
      infuraApiKey,
      evmCache,
    })
    if (result.error) {
      errors.push(result.error)
      if (
        result.error === "missing HELIUS_API_KEY"
        || result.error === "missing INFURA_API_KEY"
      ) {
        break
      }
      continue
    }
    outcomes.push(...result.outcomes)
    cursorUpdates.push(...result.cursorUpdates)
  }

  let convergenceAlerts = 0
  let convergenceEnqueues = 0
  if (cursorUpdates.length > 0 || outcomes.length > 0) {
    if (outcomes.length > 0) {
      await writeJsonRecord(
        join(archive.outcomes, `wallet-buy-${args.runId}.json`),
        { schema: 1, runId: args.runId, outcomes } as never,
      )
    }
    await withAgentWorkspaceLock(args.agentRoot, async () => {
      const fresh = store.loadWallets()
      let cursors = [...fresh.cursors]
      for (const next of cursorUpdates) {
        cursors = upsertCursor(cursors, next)
      }
      await store.saveWallets({ ...fresh, cursors })
      const convergence = await runWalletConvergence({
        agentRoot: args.agentRoot,
        archiveRoot: args.archiveRoot,
        runId: args.runId,
        family: args.family,
        newOutcomes: outcomes.filter((o) => (o.side ?? "buy") === "buy"),
        ...(args.blockExternalEffects !== undefined
          ? { blockExternalEffects: args.blockExternalEffects }
          : {}),
      })
      convergenceAlerts = convergence.alertsStaged
      convergenceEnqueues = convergence.researchEnqueued
    })
  }

  return writeReport({
    runId: args.runId,
    family: args.family,
    status: errors.length > 0 ? "degraded" : "completed",
    totalWallets,
    eligibleStatusCount: statusEligible.length,
    eligibleFamilyCount: trackable.length,
    walletsSelected: selected.length,
    walletsScanned: selected.length,
    actionsRecorded: outcomes.length,
    cursorsUpdated: cursorUpdates.length,
    convergenceAlerts,
    convergenceEnqueues,
    errors,
  })
}
