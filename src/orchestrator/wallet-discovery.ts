import { join } from "node:path"
import { ensureArchive, writeJsonRecord } from "../lib/archive.js"
import { getChain } from "../lib/chains.js"
import { StateStore } from "../lib/state.js"
import { systemClock } from "../lib/clock.js"
import { discoverSolanaEarlyBuyers } from "../collectors/wallets/helius-provider.js"
import {
  discoverEvmEarlyBuyers,
  networkForChain,
  type EvmClientOptions,
} from "../collectors/wallets/evm-provider.js"
import {
  registerWalletCandidates,
  type WalletDiscoverySighting,
} from "../wallets/discovery.js"
import type { WalletScanCursor, WatchlistFile } from "../contracts/schemas.js"

export type WalletDiscoverySkippedReason =
  | "no-active-watchlist-subjects"
  | "no-wallet-supported-subjects"
  | "dry-collect"

export type WalletDiscoveryReport = Readonly<{
  runId: string
  status: "completed" | "skipped" | "degraded"
  skippedReason?: WalletDiscoverySkippedReason
  tokensConsidered: number
  eligibleTokens: number
  supportedTokens: number
  providerAttempts: number
  sightings: number
  candidatesAdded: number
  cursorsUpdated: number
  errors: readonly string[]
}>

function tokenSubjects(watchlist: WatchlistFile): Array<Readonly<{
  chain: string
  tokenAddress: string
  origin: "watchlist"
}>> {
  return watchlist.entries
    .filter((entry) => entry.status === "tracking" || entry.status === "watching")
    .map((entry) => ({
      chain: entry.identity.chain,
      tokenAddress: entry.identity.tokenAddress,
      origin: "watchlist" as const,
    }))
}

function cursorFor(
  cursors: readonly WalletScanCursor[],
  chain: string,
  subject: string,
): WalletScanCursor | undefined {
  return cursors.find((c) => (
    c.chain === chain && c.kind === "token-discovery" && c.subject === subject
  ))
}

function upsertCursor(
  cursors: readonly WalletScanCursor[],
  next: WalletScanCursor,
): WalletScanCursor[] {
  const filtered = cursors.filter((c) => !(
    c.chain === next.chain && c.kind === next.kind && c.subject === next.subject
  ))
  return [...filtered, next].sort((a, b) => (
    a.chain === b.chain
      ? a.subject.localeCompare(b.subject)
      : a.chain.localeCompare(b.chain)
  ))
}

export async function runWalletDiscovery(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  runId: string
  dryRun?: boolean
}>): Promise<WalletDiscoveryReport> {
  const heliusApiKey = process.env["HELIUS_API_KEY"]?.trim()
  const infuraApiKey = process.env["INFURA_API_KEY"]?.trim()
  const store = new StateStore(join(args.agentRoot, "state"))
  const archive = await ensureArchive(args.archiveRoot)
  const nowIso = systemClock.nowIso()
  let file = store.loadWallets()
  const subjects = tokenSubjects(store.loadWatchlist())
  const eligibleTokens = subjects.length
  const supported = subjects.filter((subject) => {
    const chain = getChain(subject.chain)
    return Boolean(chain && chain.walletTracking !== "unsupported")
  })
  const supportedTokens = supported.length

  if (args.dryRun) {
    const report: WalletDiscoveryReport = {
      runId: args.runId,
      status: "skipped",
      skippedReason: "dry-collect",
      tokensConsidered: subjects.length,
      eligibleTokens,
      supportedTokens,
      providerAttempts: 0,
      sightings: 0,
      candidatesAdded: 0,
      cursorsUpdated: 0,
      errors: [],
    }
    await writeJsonRecord(join(archive.wallets, `${args.runId}-discovery-report.json`), report as never)
    return report
  }

  if (eligibleTokens === 0) {
    const report: WalletDiscoveryReport = {
      runId: args.runId,
      status: "skipped",
      skippedReason: "no-active-watchlist-subjects",
      tokensConsidered: 0,
      eligibleTokens: 0,
      supportedTokens: 0,
      providerAttempts: 0,
      sightings: 0,
      candidatesAdded: 0,
      cursorsUpdated: 0,
      errors: [],
    }
    await writeJsonRecord(join(archive.wallets, `${args.runId}-discovery-report.json`), report as never)
    return report
  }

  if (supportedTokens === 0) {
    const report: WalletDiscoveryReport = {
      runId: args.runId,
      status: "skipped",
      skippedReason: "no-wallet-supported-subjects",
      tokensConsidered: subjects.length,
      eligibleTokens,
      supportedTokens: 0,
      providerAttempts: 0,
      sightings: 0,
      candidatesAdded: 0,
      cursorsUpdated: 0,
      errors: [],
    }
    await writeJsonRecord(join(archive.wallets, `${args.runId}-discovery-report.json`), report as never)
    return report
  }

  const sightings: WalletDiscoverySighting[] = []
  const errors: string[] = []
  let cursorsUpdated = 0
  let cursors = [...file.cursors]
  let providerAttempts = 0

  for (const subject of supported) {
    const chain = getChain(subject.chain)
    if (!chain || chain.walletTracking === "unsupported") continue
    try {
      if (chain.walletTracking === "helius") {
        if (!heliusApiKey) {
          errors.push(`missing HELIUS_API_KEY for ${subject.tokenAddress}`)
          continue
        }
        providerAttempts += 1
        const existing = cursorFor(cursors, subject.chain, subject.tokenAddress)
        const result = await discoverSolanaEarlyBuyers({
          helius: { apiKey: heliusApiKey },
          tokenMint: subject.tokenAddress,
          ...(existing ? { before: existing.cursor } : {}),
          maxPages: 2,
        })
        for (const address of result.buyers) {
          sightings.push({
            chain: subject.chain,
            address,
            origin: subject.origin,
            tokenAddress: subject.tokenAddress,
          })
        }
        if (result.nextBefore) {
          cursors = upsertCursor(cursors, {
            schema: 1,
            chain: subject.chain as WalletScanCursor["chain"],
            kind: "token-discovery",
            subject: subject.tokenAddress,
            cursor: result.nextBefore,
            updatedAt: nowIso,
          })
          cursorsUpdated += 1
        }
        await writeJsonRecord(
          join(archive.wallets, `${args.runId}-${subject.chain}-${subject.tokenAddress.slice(0, 12)}.json`),
          { kind: "discovery", chain: subject.chain, token: subject.tokenAddress, buyers: [...result.buyers] },
        )
      } else {
        const network = networkForChain(subject.chain)
        const client: EvmClientOptions = {
          network,
          ...(network === "robinhood"
            ? {}
            : infuraApiKey
              ? { apiKey: infuraApiKey }
              : {}),
        }
        if (network !== "robinhood" && !client.apiKey) {
          errors.push(`missing INFURA_API_KEY for ${subject.tokenAddress}`)
          continue
        }
        providerAttempts += 1
        const existing = cursorFor(cursors, subject.chain, subject.tokenAddress)
        const fromBlock = existing ? Number(existing.cursor) : 0
        const result = await discoverEvmEarlyBuyers({
          client,
          tokenAddress: subject.tokenAddress,
          fromBlock,
          maxBlocks: network === "robinhood" ? 400 : 2_000,
        })
        for (const address of result.buyers) {
          sightings.push({
            chain: subject.chain,
            address,
            origin: subject.origin,
            tokenAddress: subject.tokenAddress,
          })
        }
        cursors = upsertCursor(cursors, {
          schema: 1,
          chain: subject.chain as WalletScanCursor["chain"],
          kind: "token-discovery",
          subject: subject.tokenAddress,
          cursor: String(result.nextFromBlock),
          updatedAt: nowIso,
        })
        cursorsUpdated += 1
        await writeJsonRecord(
          join(archive.wallets, `${args.runId}-${subject.chain}-${subject.tokenAddress.slice(0, 12)}.json`),
          { kind: "discovery", chain: subject.chain, token: subject.tokenAddress, buyers: [...result.buyers] },
        )
      }
    } catch (error) {
      errors.push(`${subject.tokenAddress}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const beforeCount = file.wallets.length
  file = registerWalletCandidates(file, sightings, nowIso)
  file = { ...file, cursors }
  const candidatesAdded = file.wallets.length - beforeCount

  if (!args.dryRun) {
    await store.saveWallets(file)
  }

  const missingKeys = errors.some((e) => e.includes("missing "))
  const status = missingKeys && providerAttempts === 0
    ? "degraded"
    : errors.length > 0
      ? "degraded"
      : "completed"

  const report: WalletDiscoveryReport = {
    runId: args.runId,
    status,
    tokensConsidered: subjects.length,
    eligibleTokens,
    supportedTokens,
    providerAttempts,
    sightings: sightings.length,
    candidatesAdded,
    cursorsUpdated,
    errors,
  }
  await writeJsonRecord(join(archive.wallets, `${args.runId}-discovery-report.json`), report as never)
  return report
}
