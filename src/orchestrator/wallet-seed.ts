import { readFileSync } from "node:fs"
import { join } from "node:path"
import { StateStore } from "../lib/state.js"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { Outbox } from "../lib/outbox.js"
import { WorkspaceLock, agentLockPath } from "../lib/lock.js"
import { archiveLayout, ensureArchive } from "../lib/archive.js"
import {
  OperatorSeedFileSchema,
  seedWalletsFromOperatorList,
  type OperatorSeedFile,
} from "../wallets/seed.js"
import { transitionToRouterEvent } from "../wallets/lifecycle.js"
import type { WalletTransition } from "../contracts/schemas.js"

export function loadOperatorSeedFile(path: string): OperatorSeedFile {
  return OperatorSeedFileSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export async function applyOperatorWalletSeed(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  seedPath: string
  runId?: string
  nowIso?: string
  blockExternalEffects?: boolean
}>): Promise<Readonly<{
  added: number
  skippedWatchlist: number
  skippedSources: number
  walletIds: string[]
  transitionIds: string[]
  receiptPath: string
  staged: number
  routerStaged: boolean
}>> {
  const lock = new WorkspaceLock(agentLockPath(args.agentRoot))
  if (!lock.tryAcquire()) {
    throw new Error("workspace lock held — another writer owns agent state")
  }

  try {
    const seed = loadOperatorSeedFile(args.seedPath)
    const store = new StateStore(join(args.agentRoot, "state"))
    const nowIso = args.nowIso ?? new Date().toISOString()
    const runId = args.runId ?? `wallet-seed-${nowIso.replace(/[:.]/gu, "-")}`
    const result = seedWalletsFromOperatorList({
      entries: seed.wallets,
      existing: store.loadWallets(),
      nowIso,
      runId,
    })
    await store.saveWallets(result.file)

    const archive = await ensureArchive(args.archiveRoot)
    let staged = 0
    const blockExternal = Boolean(args.blockExternalEffects)
    if (!blockExternal && result.transitions.length > 0) {
      const outbox = new Outbox(join(archive.routerOutbox, runId))
      for (const transition of result.transitions) {
        await outbox.stage(transitionToRouterEvent(transition))
        staged += 1
      }
    }

    const receiptPath = join(args.archiveRoot, "wallet-seeds", `${runId}.json`)
    await writeAtomicFile(receiptPath, `${JSON.stringify({
      schema: 1,
      runId,
      seededAt: nowIso,
      seedPath: args.seedPath,
      added: result.added,
      skippedWatchlist: seed.watchlist.length,
      skippedSources: seed.sources.length,
      walletIds: result.file.wallets.map((w) => w.walletId),
      transitions: result.transitions,
      staged,
      routerStaged: staged > 0,
      blockedExternal: blockExternal,
    }, null, 2)}\n`)

    return {
      added: result.added,
      skippedWatchlist: seed.watchlist.length,
      skippedSources: seed.sources.length,
      walletIds: result.file.wallets.map((w) => w.walletId),
      transitionIds: result.transitions.map((t: WalletTransition) => t.transitionId),
      receiptPath,
      staged,
      routerStaged: staged > 0,
    }
  } finally {
    lock.release()
  }
}

export function walletSeedOutboxDir(archiveRoot: string, runId: string): string {
  return join(archiveLayout(archiveRoot).routerOutbox, runId)
}
