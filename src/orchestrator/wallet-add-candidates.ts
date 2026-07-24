import { readFileSync } from "node:fs"
import { join } from "node:path"
import { StateStore } from "../lib/state.js"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { WorkspaceLock, agentLockPath } from "../lib/lock.js"
import { addOperatorNominatedCandidates } from "../wallets/discovery.js"
import { OperatorCandidateFileSchema } from "../wallets/seed.js"

export function loadOperatorCandidateFile(path: string) {
  return OperatorCandidateFileSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export async function applyOperatorWalletCandidates(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  seedPath: string
  runId?: string
  nowIso?: string
  dryRun?: boolean
}>): Promise<Readonly<{
  added: number
  skippedExisting: number
  skippedExcluded: number
  skippedInvalid: number
  walletIds: string[]
  receiptPath: string
  dryRun: boolean
}>> {
  const lock = new WorkspaceLock(agentLockPath(args.agentRoot))
  if (!lock.tryAcquire()) {
    throw new Error("workspace lock held — another writer owns agent state")
  }

  try {
    const seed = loadOperatorCandidateFile(args.seedPath)
    const store = new StateStore(join(args.agentRoot, "state"))
    const nowIso = args.nowIso ?? new Date().toISOString()
    const runId = args.runId ?? `wallet-add-candidates-${nowIso.replace(/[:.]/gu, "-")}`
    const entries = seed.wallets.map((entry) => ({
      chain: entry.chain,
      address: entry.address,
      ...(entry.note ? { note: entry.note } : {}),
    }))
    const result = addOperatorNominatedCandidates(
      store.loadWallets(),
      entries,
      nowIso,
    )

    if (!args.dryRun) {
      await store.saveWallets(result.file)
    }

    const receiptPath = join(args.archiveRoot, "wallet-candidates", `${runId}.json`)
    await writeAtomicFile(receiptPath, `${JSON.stringify({
      schema: 1,
      runId,
      nominatedAt: nowIso,
      seedPath: args.seedPath,
      added: result.added,
      skippedExisting: result.skippedExisting,
      skippedExcluded: result.skippedExcluded,
      skippedInvalid: result.skippedInvalid,
      walletIds: result.addedWalletIds,
      dryRun: Boolean(args.dryRun),
    }, null, 2)}\n`)

    return {
      added: result.added,
      skippedExisting: result.skippedExisting,
      skippedExcluded: result.skippedExcluded,
      skippedInvalid: result.skippedInvalid,
      walletIds: result.addedWalletIds,
      receiptPath,
      dryRun: Boolean(args.dryRun),
    }
  } finally {
    lock.release()
  }
}
