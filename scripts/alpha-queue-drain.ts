/**
 * Operator backlog drain: write a valid alpha-digest rollup and purge via host validation.
 * Use when the agent digest shape is wrong or the queue must clear without a full list-scan.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { writeAtomicFileFsync, sha256Bytes } from "../src/lib/fs-atomic.js"
import { createRunId } from "../src/lib/run-id.js"
import { ensureArchive } from "../src/lib/archive.js"
import { listPendingAlphaPaths } from "../src/orchestrator/review-collect.js"
import { validateAndPurgeAlphaDigest } from "../src/orchestrator/alpha.js"

const MAX_ENTRIES = 500
const DEFAULT_AGENT = join(homedir(), ".trenchcoat", "agent")
const DEFAULT_ARCHIVE = join(homedir(), ".trenchcoat", "archive")

function parseArgs(): { agentRoot: string; archiveRoot: string; dryRun: boolean } {
  const args = process.argv.slice(2)
  let agentRoot = DEFAULT_AGENT
  let archiveRoot = DEFAULT_ARCHIVE
  let dryRun = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--dry-run") dryRun = true
    else if (a === "--agent" && args[i + 1]) agentRoot = args[++i]
    else if (a === "--archive" && args[i + 1]) archiveRoot = args[++i]
  }
  return { agentRoot, archiveRoot, dryRun }
}

function parseQueuePath(rel: string): { channel: string; messageId: string } | null {
  const m = /^alpha-queue\/([^/]+)\/(\d+)\.json$/u.exec(rel)
  if (!m) return null
  return { channel: m[1], messageId: m[2] }
}

async function drainBatch(
  agentRoot: string,
  archiveRoot: string,
  batchIndex: number,
  paths: string[],
  dryRun: boolean,
): Promise<{ accepted: number; purged: number; runId: string }> {
  const now = new Date()
  const runId = createRunId("alpha-drain", now)
  const nowIso = now.toISOString()
  const recordPath = `state/research/alpha-drain-${nowIso.slice(0, 10)}-batch${batchIndex}.md`
  const lines = [
    "---",
    "description: Operator alpha-queue backlog drain — messages acknowledged without per-message distillation",
    "status: archived",
    `last_verified: ${nowIso.slice(0, 10)}`,
    "---",
    "",
    `Batch ${batchIndex}: ${paths.length} telegram alpha message(s) purged via host digest validation.`,
    "",
  ]
  for (const rel of paths) {
    const parsed = parseQueuePath(rel)
    if (parsed) lines.push(`- telegram:${parsed.channel} messageId=${parsed.messageId}`)
  }
  const recordBody = `${lines.join("\n")}\n`
  const recordHash = sha256Bytes(recordBody)

  const entries = paths.map((rel) => {
    const parsed = parseQueuePath(rel)
    if (!parsed) throw new Error(`unexpected queue path: ${rel}`)
    const abs = join(agentRoot, rel)
    const contentHash = sha256Bytes(readFileSync(abs))
    return {
      provenance: `telegram:${parsed.channel}`,
      channel: parsed.channel,
      messageId: parsed.messageId,
      contentHash,
      records: [{ path: recordPath, contentHash: recordHash }],
    }
  })

  const digest = {
    schema: 1 as const,
    runId,
    proposedAt: nowIso,
    entries,
  }

  const layout = await ensureArchive(archiveRoot)
  const reportsDir = join(agentRoot, "reports", runId)
  const recordAbs = join(agentRoot, recordPath)

  if (dryRun) {
    console.log(`[dry-run] batch ${batchIndex}: would purge ${entries.length} entries runId=${runId}`)
    return { accepted: entries.length, purged: 0, runId }
  }

  await writeAtomicFileFsync(recordAbs, recordBody)
  await writeAtomicFileFsync(join(reportsDir, "alpha-digest.json"), `${JSON.stringify(digest, null, 2)}\n`)

  const receipt = await validateAndPurgeAlphaDigest({
    agentRoot,
    layout,
    runId,
    nowIso,
  })

  return {
    accepted: receipt.accepted.length,
    purged: receipt.purgedIds.length,
    runId,
  }
}

async function main(): Promise<void> {
  const { agentRoot, archiveRoot, dryRun } = parseArgs()
  const pendingBefore = listPendingAlphaPaths(agentRoot)
  console.log(`agent=${agentRoot} pending=${pendingBefore.length} dryRun=${dryRun}`)

  if (pendingBefore.length === 0) {
    console.log("queue already empty")
    return
  }

  let batchIndex = 0
  let totalPurged = 0
  while (true) {
    const pending = listPendingAlphaPaths(agentRoot)
    if (pending.length === 0) break
    batchIndex++
    const batch = pending.slice(0, MAX_ENTRIES)
    const result = await drainBatch(agentRoot, archiveRoot, batchIndex, batch, dryRun)
    totalPurged += result.purged
    console.log(
      `batch ${batchIndex} runId=${result.runId} accepted=${result.accepted} purged=${result.purged} remaining=${pending.length - result.purged}`,
    )
    if (dryRun) break
    if (result.purged === 0) {
      console.error("purge stalled — check alpha-digest-receipt.json for rejectReason")
      process.exitCode = 1
      break
    }
  }

  const pendingAfter = listPendingAlphaPaths(agentRoot)
  console.log(`done purged=${totalPurged} remaining=${pendingAfter.length}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
