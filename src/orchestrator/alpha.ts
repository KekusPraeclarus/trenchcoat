import { existsSync, readFileSync, rmSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { sha256Bytes } from "../lib/fs-atomic.js"
import { runArchiveDir, writeJsonRecordFsync, type ArchiveLayout } from "../lib/archive.js"
import {
  AlphaDigestFileSchema,
  type AlphaDigestEntry,
  type AlphaDigestReceipt,
} from "../contracts/schemas.js"

/** agent/reports/<run-id>/alpha-digest.json — the untrusted proposal the agent wrote */
export function alphaDigestProposalPath(agentRoot: string, runId: string): string {
  return join(agentRoot, "reports", runId, "alpha-digest.json")
}

function alphaMessagePath(agentRoot: string, channel: string, messageId: string): string {
  return join(agentRoot, "alpha-queue", channel, `${messageId}.json`)
}

/**
 * Resolve rel under root, refusing anything that escapes the tree. The record-path
 * schema permits dots and slashes, so state/../secret would pass validation — the
 * confinement check here is the real boundary, not the regex.
 */
function resolveUnder(root: string, rel: string): string | undefined {
  const base = resolve(root)
  const full = resolve(base, rel)
  if (full !== base && !full.startsWith(base + sep)) return undefined
  return full
}

function fileHashMatches(path: string, expected: string): boolean {
  if (!existsSync(path)) return false
  return sha256Bytes(readFileSync(path)) === expected
}

/** Reason an entry could not be accepted; the message file is retained untouched */
function rejectReason(agentRoot: string, entry: AlphaDigestEntry): string | undefined {
  const messagePath = alphaMessagePath(agentRoot, entry.channel, entry.messageId)
  if (!existsSync(messagePath)) return "message-missing"
  if (!fileHashMatches(messagePath, entry.contentHash)) return "message-hash-mismatch"
  for (const record of entry.records) {
    const recordPath = resolveUnder(agentRoot, record.path)
    if (!recordPath) return "record-path-escapes-agent"
    if (!existsSync(recordPath)) return "record-missing"
    if (!fileHashMatches(recordPath, record.contentHash)) return "record-hash-mismatch"
  }
  return undefined
}

function emptyReceipt(
  runId: string,
  nowIso: string,
  invalidReason?: AlphaDigestReceipt["invalidReason"],
): AlphaDigestReceipt {
  return {
    schema: 1,
    runId,
    validatedAt: nowIso,
    accepted: [],
    rejected: [],
    purgedIds: [],
    ...(invalidReason ? { invalidReason } : {}),
  }
}

/**
 * Validate the agent's alpha digest against the queue on disk and purge only the
 * message files whose declared content still matches byte-for-byte. Fails closed:
 * a missing, malformed, or run-mismatched digest deletes nothing.
 */
export async function validateAndPurgeAlphaDigest(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  runId: string
  nowIso: string
}>): Promise<AlphaDigestReceipt> {
  const receiptPath = join(runArchiveDir(args.layout, args.runId), "alpha-digest-receipt.json")
  const digestPath = alphaDigestProposalPath(args.agentRoot, args.runId)

  if (!existsSync(digestPath)) {
    const receipt = emptyReceipt(args.runId, args.nowIso)
    await writeJsonRecordFsync(receiptPath, receipt as never)
    return receipt
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(digestPath, "utf8"))
  } catch {
    const receipt = emptyReceipt(args.runId, args.nowIso, "schema-invalid")
    await writeJsonRecordFsync(receiptPath, receipt as never)
    return receipt
  }

  const parsed = AlphaDigestFileSchema.safeParse(raw)
  if (!parsed.success) {
    const receipt = emptyReceipt(args.runId, args.nowIso, "schema-invalid")
    await writeJsonRecordFsync(receiptPath, receipt as never)
    return receipt
  }
  if (parsed.data.runId !== args.runId) {
    const receipt = emptyReceipt(args.runId, args.nowIso, "run-id-mismatch")
    await writeJsonRecordFsync(receiptPath, receipt as never)
    return receipt
  }

  const accepted: AlphaDigestEntry[] = []
  const rejected: { messageId: string; reason: string }[] = []
  for (const entry of parsed.data.entries) {
    const reason = rejectReason(args.agentRoot, entry)
    if (reason) rejected.push({ messageId: entry.messageId, reason })
    else accepted.push(entry)
  }

  // Purge only accepted messages; retains everything the agent could not prove.
  const purgedIds: string[] = []
  for (const entry of accepted) {
    rmSync(alphaMessagePath(args.agentRoot, entry.channel, entry.messageId), { force: true })
    purgedIds.push(entry.messageId)
  }

  const receipt: AlphaDigestReceipt = {
    schema: 1,
    runId: args.runId,
    validatedAt: args.nowIso,
    accepted,
    rejected,
    purgedIds,
  }
  await writeJsonRecordFsync(receiptPath, receipt as never)
  return receipt
}
