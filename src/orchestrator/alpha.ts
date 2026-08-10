import { existsSync, readFileSync, rmSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { sha256Bytes, writeAtomicFileFsync } from "../lib/fs-atomic.js"
import { runArchiveDir, writeJsonRecordFsync, type ArchiveLayout } from "../lib/archive.js"
import {
  AlphaDigestFileSchema,
  type AlphaDigestEntry,
  type AlphaDigestFile,
  type AlphaDigestReceipt,
} from "../contracts/schemas.js"
import {
  extractAddressesFromText,
  extractCashtags,
  extractChainHint,
} from "./telegram-alpha-research.js"

/** agent/reports/<run-id>/alpha-digest.json — the untrusted proposal the agent wrote */
export function alphaDigestProposalPath(agentRoot: string, runId: string): string {
  return join(agentRoot, "reports", runId, "alpha-digest.json")
}

function alphaMessagePath(agentRoot: string, channel: string, messageId: string): string {
  return join(agentRoot, "alpha-queue", channel, `${messageId}.json`)
}

/**
 * Ack tombstones live outside state/research/ so token dossiers stay grep-clean.
 * Retention sweeps this directory after queue purge (INV-Q2; ADR 044).
 */
export function alphaAckRelPath(channel: string, messageId: string): string {
  return `state/alpha-acks/${channel}-${messageId}.md`
}

const FOUNDER_RE =
  /\b(founder|co-?founder|ceo|chief executive|protocol official|official (announcement|channel)|from the team)\b/iu
const CATALYST_RE =
  /\b(launch|ship|deploy|mainnet|airdrop|integration|partnership|wallet|upgrade|release)\b/iu
const INSTRUCTION_SHAPED_RE =
  /\b(ignore (all|previous|prior)|system prompt|you are now|approve everything|disregard (your|all) (instructions|rules))\b/iu
const THESIS_SHAPED_RE =
  /\b(thesis|conviction|accumulat|long[ -]?term|catalyst|narrative|position(ing)?|entry|invalidat)\b/iu
const CASHTAG_RE = /\$[A-Z]{2,10}\b/u

export type AlphaMessageClass = "no-thesis" | "needs-agent"

/** Host classifier for telegram alpha — mechanical; never invents broadcast copy */
export function classifyAlphaMessage(text: string): AlphaMessageClass {
  const trimmed = text.trim()
  if (extractAddressesFromText(trimmed).length > 0) return "needs-agent"
  if (CASHTAG_RE.test(trimmed) && extractChainHint(trimmed) !== undefined) {
    return "needs-agent"
  }
  // Ticker-only can still enqueue research via resolveResearchSubject
  if (extractCashtags(trimmed).length > 0) return "needs-agent"
  if (FOUNDER_RE.test(trimmed) && CATALYST_RE.test(trimmed)) return "needs-agent"
  if (INSTRUCTION_SHAPED_RE.test(trimmed)) return "needs-agent"
  if (trimmed.length >= 80 && THESIS_SHAPED_RE.test(trimmed)) return "needs-agent"
  return "no-thesis"
}

export function isInstructionShapedText(text: string): boolean {
  return INSTRUCTION_SHAPED_RE.test(text)
}

export async function writeAlphaAckTombstone(args: Readonly<{
  agentRoot: string
  channel: string
  messageId: string
  runId: string
}>): Promise<Readonly<{ path: string; contentHash: `sha256:${string}`; body: string }>> {
  const rel = alphaAckRelPath(args.channel, args.messageId)
  const body = [
    "# Alpha ack",
    `seen: telegram:${args.channel} messageId=${args.messageId}`,
    "verdict: no-thesis",
    `runId: ${args.runId}`,
    "",
  ].join("\n")
  const abs = join(args.agentRoot, rel)
  await writeAtomicFileFsync(abs, body)
  return {
    path: rel,
    contentHash: sha256Bytes(Buffer.from(body)),
    body,
  }
}

export function parseAlphaQueueRelPath(
  rel: string,
): { channel: string; messageId: string } | null {
  const m = /^alpha-queue\/([^/]+)\/(\d+)\.json$/u.exec(rel)
  if (!m) return null
  return { channel: m[1]!, messageId: m[2]! }
}

function readQueueMessageText(agentRoot: string, rel: string): string | undefined {
  const abs = join(agentRoot, rel)
  if (!existsSync(abs)) return undefined
  try {
    const raw = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>
    const items = raw["items"]
    if (!Array.isArray(items) || items.length === 0) return undefined
    const first = items[0]
    if (first === null || typeof first !== "object" || Array.isArray(first)) return undefined
    const text = (first as Record<string, unknown>)["text"]
    return typeof text === "string" ? text : undefined
  } catch {
    return undefined
  }
}

export type HostAlphaAckResult = Readonly<{
  hostEntries: readonly AlphaDigestEntry[]
  needsAgentPaths: readonly string[]
  ackedPaths: readonly string[]
}>

/**
 * Classify pending alpha-queue paths; write tombstones + digest entries for
 * no-thesis messages. Returns paths that still need an agent digest.
 */
export async function hostAckNoThesisAlphaMessages(args: Readonly<{
  agentRoot: string
  runId: string
  paths: readonly string[]
  /** Optional sealed text by queue rel path (preferred over reading queue JSON) */
  sealedTextByPath?: ReadonlyMap<string, string>
}>): Promise<HostAlphaAckResult> {
  const hostEntries: AlphaDigestEntry[] = []
  const needsAgentPaths: string[] = []
  const ackedPaths: string[] = []

  for (const rel of args.paths) {
    const parsed = parseAlphaQueueRelPath(rel)
    if (!parsed) {
      needsAgentPaths.push(rel)
      continue
    }
    const abs = join(args.agentRoot, rel)
    if (!existsSync(abs)) {
      needsAgentPaths.push(rel)
      continue
    }
    const text = args.sealedTextByPath?.get(rel) ?? readQueueMessageText(args.agentRoot, rel) ?? ""
    if (classifyAlphaMessage(text) === "needs-agent") {
      needsAgentPaths.push(rel)
      continue
    }
    const contentHash = sha256Bytes(readFileSync(abs))
    const tombstone = await writeAlphaAckTombstone({
      agentRoot: args.agentRoot,
      channel: parsed.channel,
      messageId: parsed.messageId,
      runId: args.runId,
    })
    hostEntries.push({
      provenance: `telegram:${parsed.channel}`,
      channel: parsed.channel,
      messageId: parsed.messageId,
      contentHash,
      records: [{ path: tombstone.path, contentHash: tombstone.contentHash }],
    })
    ackedPaths.push(rel)
  }

  return { hostEntries, needsAgentPaths, ackedPaths }
}

/** Host wins on duplicate channel+messageId; agent entries kept otherwise */
export function mergeAlphaDigestEntries(
  hostEntries: readonly AlphaDigestEntry[],
  agentEntries: readonly AlphaDigestEntry[],
): AlphaDigestEntry[] {
  const byKey = new Map<string, AlphaDigestEntry>()
  for (const entry of agentEntries) {
    byKey.set(`${entry.channel}\0${entry.messageId}`, entry)
  }
  for (const entry of hostEntries) {
    byKey.set(`${entry.channel}\0${entry.messageId}`, entry)
  }
  return [...byKey.values()]
}

export async function writeMergedAlphaDigest(args: Readonly<{
  agentRoot: string
  runId: string
  proposedAt: string
  hostEntries: readonly AlphaDigestEntry[]
  agentEntries?: readonly AlphaDigestEntry[]
}>): Promise<AlphaDigestFile> {
  const digest: AlphaDigestFile = {
    schema: 1,
    runId: args.runId,
    proposedAt: args.proposedAt,
    entries: mergeAlphaDigestEntries(args.hostEntries, args.agentEntries ?? []),
  }
  const path = alphaDigestProposalPath(args.agentRoot, args.runId)
  await writeAtomicFileFsync(path, `${JSON.stringify(digest, null, 2)}\n`)
  return digest
}

export function readAgentAlphaDigestEntries(
  agentRoot: string,
  runId: string,
): readonly AlphaDigestEntry[] {
  const path = alphaDigestProposalPath(agentRoot, runId)
  if (!existsSync(path)) return []
  try {
    const parsed = AlphaDigestFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")))
    if (!parsed.success) return []
    return parsed.data.entries
  } catch {
    return []
  }
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
