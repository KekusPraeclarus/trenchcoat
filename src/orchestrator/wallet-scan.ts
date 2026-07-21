import { join } from "node:path"
import { ensureArchive, writeJsonRecord } from "../lib/archive.js"
import { getChain } from "../lib/chains.js"
import { StateStore } from "../lib/state.js"
import { systemClock } from "../lib/clock.js"
import { sha256Json } from "../lib/canonical-json.js"
import { listSolanaWalletActions } from "../collectors/wallets/helius-provider.js"
import {
  createEvmRunCache,
  listEvmWalletActions,
  networkForChain,
  type EvmClientOptions,
} from "../collectors/wallets/evm-provider.js"
import { eligibleWalletActions } from "../wallets/providers.js"
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
  }>
}>): WalletBuyOutcome {
  const boughtAt = new Date(
    args.action.timestamp > 1_000_000_000_000
      ? args.action.timestamp
      : args.action.timestamp * 1_000,
  ).toISOString()
  const eventId = sha256Json({
    walletId: args.wallet.walletId,
    token: args.action.tokenAddress,
    providerEventId: args.action.providerEventId,
    ts: boughtAt,
  }).slice("sha256:".length).slice(0, 32)
  return {
    schema: 1,
    eventId: `wb_${eventId}`,
    walletId: args.wallet.walletId,
    chain: args.chain,
    tokenAddress: args.action.tokenAddress,
    boughtAt,
    finalized: args.action.finalized,
    removed: Boolean(args.action.removed),
    priceable: args.action.priceable,
    rug: false,
    providerEventId: args.action.providerEventId,
    walletStatusAtEvent: args.wallet.status,
  }
}

function quoteAssetsFor(chainSlug: string) {
  const chain = getChain(chainSlug)
  return chain?.quoteAssets ?? { acceptNative: true, allowlist: [] as readonly string[] }
}

export async function runWalletScan(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  runId: string
  family: "solana" | "evm"
  dryRun?: boolean
  blockExternalEffects?: boolean
}>): Promise<WalletScanReport> {
  const heliusApiKey = process.env["HELIUS_API_KEY"]?.trim()
  const infuraApiKey = process.env["INFURA_API_KEY"]?.trim()
  const store = new StateStore(join(args.agentRoot, "state"))
  const archive = await ensureArchive(args.archiveRoot)
  const nowIso = systemClock.nowIso()
  let file = store.loadWallets()
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

  if (args.dryRun) {
    const report: WalletScanReport = {
      runId: args.runId,
      family: args.family,
      status: "skipped",
      skippedReason: "dry-collect",
      totalWallets,
      eligibleStatusCount: statusEligible.length,
      eligibleFamilyCount: trackable.length,
      walletsScanned: 0,
      actionsRecorded: 0,
      cursorsUpdated: 0,
      errors: [],
    }
    await writeJsonRecord(join(archive.wallets, `${args.runId}-scan-report.json`), report as never)
    return report
  }

  if (totalWallets === 0) {
    const report: WalletScanReport = {
      runId: args.runId,
      family: args.family,
      status: "skipped",
      skippedReason: "wallet-state-empty",
      totalWallets: 0,
      eligibleStatusCount: 0,
      eligibleFamilyCount: 0,
      walletsScanned: 0,
      actionsRecorded: 0,
      cursorsUpdated: 0,
      errors: [],
    }
    await writeJsonRecord(join(archive.wallets, `${args.runId}-scan-report.json`), report as never)
    return report
  }

  if (statusEligible.length === 0) {
    const report: WalletScanReport = {
      runId: args.runId,
      family: args.family,
      status: "skipped",
      skippedReason: "no-eligible-wallet-status",
      totalWallets,
      eligibleStatusCount: 0,
      eligibleFamilyCount: 0,
      walletsScanned: 0,
      actionsRecorded: 0,
      cursorsUpdated: 0,
      errors: [],
    }
    await writeJsonRecord(join(archive.wallets, `${args.runId}-scan-report.json`), report as never)
    return report
  }

  if (trackable.length === 0) {
    const report: WalletScanReport = {
      runId: args.runId,
      family: args.family,
      status: "skipped",
      skippedReason: "no-wallets-for-family",
      totalWallets,
      eligibleStatusCount: statusEligible.length,
      eligibleFamilyCount: 0,
      walletsScanned: 0,
      actionsRecorded: 0,
      cursorsUpdated: 0,
      errors: [],
    }
    await writeJsonRecord(join(archive.wallets, `${args.runId}-scan-report.json`), report as never)
    return report
  }

  const errors: string[] = []
  let actionsRecorded = 0
  let cursorsUpdated = 0
  let cursors = [...file.cursors]
  const outcomes: WalletBuyOutcome[] = []
  const evmCache = createEvmRunCache()
  const nowMs = Date.parse(nowIso)

  for (const wallet of trackable) {
    try {
      const chain = getChain(wallet.chain)!
      const quoteAssets = quoteAssetsFor(wallet.chain)
      const needsBackfill = wallet.status === "candidate"
      if (chain.walletTracking === "helius") {
        if (!heliusApiKey) {
          errors.push("missing HELIUS_API_KEY")
          break
        }
        const tip = findCursor(cursors, wallet.chain, "wallet-scan-tip", wallet.address)
        const backfill = findCursor(cursors, wallet.chain, "wallet-scan-backfill", wallet.address)
          ?? findCursor(cursors, wallet.chain, "wallet-scan", wallet.address)
        const fromTimestamp = needsBackfill
          ? Math.min(Date.parse(wallet.addedAt), nowMs - BACKFILL_MS)
          : Date.parse(wallet.addedAt)
        const result = await listSolanaWalletActions({
          helius: { apiKey: heliusApiKey },
          walletAddress: wallet.address,
          fromTimestamp,
          ...(tip && !needsBackfill ? { until: tip.cursor } : {}),
          ...(backfill && needsBackfill ? { before: backfill.cursor } : {}),
          quoteAssets,
        })
        const eligible = eligibleWalletActions(result.actions)
        for (const action of eligible) {
          outcomes.push(outcomeFromAction({
            wallet,
            chain: wallet.chain,
            action,
          }))
        }
        actionsRecorded += eligible.length
        if (result.tipSignature) {
          cursors = upsertCursor(cursors, {
            schema: 1,
            chain: wallet.chain,
            kind: "wallet-scan-tip",
            subject: wallet.address,
            cursor: result.tipSignature,
            updatedAt: nowIso,
          })
          cursorsUpdated += 1
        }
        if (result.nextBefore) {
          cursors = upsertCursor(cursors, {
            schema: 1,
            chain: wallet.chain,
            kind: needsBackfill ? "wallet-scan-backfill" : "wallet-scan",
            subject: wallet.address,
            cursor: result.nextBefore,
            updatedAt: nowIso,
          })
          cursorsUpdated += 1
        }
      } else {
        const network = networkForChain(wallet.chain)
        const client: EvmClientOptions = {
          network,
          ...(network === "robinhood"
            ? {}
            : infuraApiKey
              ? { apiKey: infuraApiKey }
              : {}),
        }
        if (network !== "robinhood" && !client.apiKey) {
          errors.push("missing INFURA_API_KEY")
          break
        }
        const existing = findCursor(cursors, wallet.chain, "wallet-scan", wallet.address)
          ?? findCursor(cursors, wallet.chain, "wallet-scan-backfill", wallet.address)
        const fromBlock = existing ? Number(existing.cursor) : 0
        const result = await listEvmWalletActions({
          client,
          walletAddress: wallet.address,
          fromBlock,
          maxBlocks: network === "robinhood" ? 400 : 2_000,
          quoteAssets,
          cache: evmCache,
        })
        const eligible = eligibleWalletActions(result.actions)
        for (const action of eligible) {
          outcomes.push(outcomeFromAction({
            wallet,
            chain: wallet.chain,
            action,
          }))
        }
        actionsRecorded += eligible.length
        cursors = upsertCursor(cursors, {
          schema: 1,
          chain: wallet.chain,
          kind: "wallet-scan",
          subject: wallet.address,
          cursor: String(result.nextFromBlock),
          updatedAt: nowIso,
        })
        cursorsUpdated += 1
      }
    } catch (error) {
      errors.push(`${wallet.walletId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  file = { ...file, cursors }
  let convergenceAlerts = 0
  let convergenceEnqueues = 0
  if (!args.dryRun) {
    await store.saveWallets(file)
    if (outcomes.length > 0) {
      await writeJsonRecord(
        join(archive.outcomes, `wallet-buy-${args.runId}.json`),
        { schema: 1, runId: args.runId, outcomes } as never,
      )
    }
    const convergence = await runWalletConvergence({
      agentRoot: args.agentRoot,
      archiveRoot: args.archiveRoot,
      runId: args.runId,
      family: args.family,
      newOutcomes: outcomes,
      ...(args.blockExternalEffects !== undefined
        ? { blockExternalEffects: args.blockExternalEffects }
        : {}),
    })
    convergenceAlerts = convergence.alertsStaged
    convergenceEnqueues = convergence.researchEnqueued
  }

  const report: WalletScanReport = {
    runId: args.runId,
    family: args.family,
    status: errors.length > 0 ? "degraded" : "completed",
    totalWallets,
    eligibleStatusCount: statusEligible.length,
    eligibleFamilyCount: trackable.length,
    walletsScanned: trackable.length,
    actionsRecorded,
    cursorsUpdated,
    convergenceAlerts,
    convergenceEnqueues,
    errors,
  }
  await writeJsonRecord(join(archive.wallets, `${args.runId}-scan-report.json`), report as never)
  return report
}
