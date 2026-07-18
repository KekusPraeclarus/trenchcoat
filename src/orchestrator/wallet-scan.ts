import { join } from "node:path"
import { ensureArchive, writeJsonRecord } from "../lib/archive.js"
import { getChain } from "../lib/chains.js"
import { StateStore } from "../lib/state.js"
import { systemClock } from "../lib/clock.js"
import { sha256Json } from "../lib/canonical-json.js"
import { listSolanaWalletActions } from "../collectors/wallets/helius-provider.js"
import {
  listEvmWalletActions,
  networkForChain,
  type EvmClientOptions,
} from "../collectors/wallets/evm-provider.js"
import { eligibleWalletActions } from "../wallets/providers.js"
import type { WalletBuyOutcome, WalletScanCursor } from "../contracts/schemas.js"

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
  errors: readonly string[]
}>

function upsertCursor(
  cursors: readonly WalletScanCursor[],
  next: WalletScanCursor,
): WalletScanCursor[] {
  const filtered = cursors.filter((c) => !(
    c.chain === next.chain && c.kind === next.kind && c.subject === next.subject
  ))
  return [...filtered, next]
}

function outcomeFromAction(args: Readonly<{
  walletId: string
  chain: WalletBuyOutcome["chain"]
  action: Readonly<{
    walletAddress: string
    tokenAddress: string
    timestamp: number
    finalized: boolean
    removed?: boolean
    priceable: boolean
  }>
}>): WalletBuyOutcome {
  const boughtAt = new Date(
    args.action.timestamp > 1_000_000_000_000
      ? args.action.timestamp
      : args.action.timestamp * 1_000,
  ).toISOString()
  const eventId = sha256Json({
    walletId: args.walletId,
    token: args.action.tokenAddress,
    ts: boughtAt,
  }).slice("sha256:".length).slice(0, 32)
  return {
    schema: 1,
    eventId: `wb_${eventId}`,
    walletId: args.walletId,
    chain: args.chain,
    tokenAddress: args.action.tokenAddress,
    boughtAt,
    finalized: args.action.finalized,
    removed: Boolean(args.action.removed),
    priceable: args.action.priceable,
    rug: false,
  }
}

export async function runWalletScan(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  runId: string
  family: "solana" | "evm"
  dryRun?: boolean
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

  for (const wallet of trackable) {
    try {
      const chain = getChain(wallet.chain)!
      if (chain.walletTracking === "helius") {
        if (!heliusApiKey) {
          errors.push("missing HELIUS_API_KEY")
          break
        }
        const existing = cursors.find((c) => (
          c.chain === wallet.chain && c.kind === "wallet-scan" && c.subject === wallet.address
        ))
        const result = await listSolanaWalletActions({
          helius: { apiKey: heliusApiKey },
          walletAddress: wallet.address,
          fromTimestamp: Date.parse(wallet.addedAt),
          ...(existing ? { before: existing.cursor } : {}),
        })
        const eligible = eligibleWalletActions(result.actions)
        for (const action of eligible) {
          outcomes.push(outcomeFromAction({
            walletId: wallet.walletId,
            chain: wallet.chain,
            action,
          }))
        }
        actionsRecorded += eligible.length
        if (result.nextBefore) {
          cursors = upsertCursor(cursors, {
            schema: 1,
            chain: wallet.chain,
            kind: "wallet-scan",
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
        const existing = cursors.find((c) => (
          c.chain === wallet.chain && c.kind === "wallet-scan" && c.subject === wallet.address
        ))
        const fromBlock = existing ? Number(existing.cursor) : 0
        const result = await listEvmWalletActions({
          client,
          walletAddress: wallet.address,
          fromBlock,
          maxBlocks: network === "robinhood" ? 400 : 2_000,
        })
        const eligible = eligibleWalletActions(result.actions)
        for (const action of eligible) {
          outcomes.push(outcomeFromAction({
            walletId: wallet.walletId,
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
  if (!args.dryRun) {
    await store.saveWallets(file)
    if (outcomes.length > 0) {
      await writeJsonRecord(
        join(archive.outcomes, `wallet-buy-${args.runId}.json`),
        { schema: 1, runId: args.runId, outcomes } as never,
      )
    }
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
    errors,
  }
  await writeJsonRecord(join(archive.wallets, `${args.runId}-scan-report.json`), report as never)
  return report
}
