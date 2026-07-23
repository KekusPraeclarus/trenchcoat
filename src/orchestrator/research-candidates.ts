import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import {
  ResearchCandidateFileSchema,
  ResearchCandidateReceiptSchema,
  ResearchQueueEntrySchema,
  SnapshotEnvelopeSchema,
  type ResearchCandidate,
  type ResearchCandidateReceipt,
  type ResearchQueueEntry,
} from "../contracts/schemas.js"
import { runArchiveDir, writeJsonRecordFsync, type ArchiveLayout } from "../lib/archive.js"
import { loadConfig } from "../lib/config.js"
import { getChain, validateAddress } from "../lib/chains.js"
import { enqueueResearch, dedupeKeyFor } from "../lib/research-queue.js"
import type { SnapshotWriter } from "../lib/snapshot.js"
import { StateStore } from "../lib/state.js"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import {
  extractAddressesFromText,
  extractChainHint,
} from "./telegram-alpha-research.js"

export const MAX_RESEARCH_CANDIDATES_PER_RUN = 3

export function researchCandidatesPath(agentRoot: string, runId: string): string {
  return join(agentRoot, "reports", runId, "research-candidates.json")
}

function resolveUnder(root: string, rel: string): string | undefined {
  const base = resolve(root)
  const full = resolve(base, rel)
  if (full !== base && !full.startsWith(base + sep)) return undefined
  return full
}

function independentAuthorKey(item: Readonly<{ provenance: string; clusterId?: string | undefined }>): string {
  if (item.clusterId && item.clusterId.trim()) return `cluster:${item.clusterId.trim().toLowerCase()}`
  const provenance = item.provenance.trim()
  const social = /^(twitter|farcaster|telegram):(@?[A-Za-z0-9_.-]+)/iu.exec(provenance)
  if (social?.[1] && social[2]) {
    return `${social[1].toLowerCase()}:${social[2].toLowerCase()}`
  }
  return `prov:${provenance.toLowerCase().slice(0, 120)}`
}

export type SocialResearchHint = Readonly<{
  chain: string
  tokenAddress: string
  authorCount: number
  authors: readonly string[]
  evidenceRefs: readonly string[]
}>

const CHAIN_CA_IN_TEXT = /\b([a-z][a-z0-9-]{1,31}):([A-Za-z0-9]{32,128})\b/giu

function resolveHintChain(
  text: string,
  address: string,
): string | undefined {
  CHAIN_CA_IN_TEXT.lastIndex = 0
  for (const match of text.matchAll(CHAIN_CA_IN_TEXT)) {
    const slug = match[1]?.toLowerCase()
    const token = match[2]
    if (!slug || !token || token !== address) continue
    if (getChain(slug)) return slug
  }
  const hint = extractChainHint(text)
  if (hint && getChain(hint)) {
    const chain = getChain(hint)!
    if (validateAddress(chain.addressFormat, address)) return hint
  }
  if (validateAddress("base58-32", address) && !address.startsWith("0x")) {
    return "solana"
  }
  return undefined
}

/**
 * Host scan of sealed same-run inbox for multi-author CA clusters. Hint only —
 * agent still authors research-candidates.json; host validates post-session.
 */
export function detectSocialResearchCandidates(args: Readonly<{
  layout: ArchiveLayout
  runId: string
  agentRoot: string
  max?: number
}>): SocialResearchHint[] {
  const max = args.max ?? MAX_RESEARCH_CANDIDATES_PER_RUN
  const frozenInbox = join(runArchiveDir(args.layout, args.runId), "inbox")
  if (!existsSync(frozenInbox)) return []

  type Acc = {
    chain: string
    tokenAddress: string
    authors: Set<string>
    evidenceRefs: Set<string>
  }
  const byKey = new Map<string, Acc>()

  for (const fileName of readdirSync(frozenInbox).sort()) {
    if (!fileName.endsWith(".json")) continue
    if (fileName.includes("..") || fileName.includes("\0") || fileName.includes("/")) continue
    const frozenPath = join(frozenInbox, fileName)
    let envelope
    try {
      envelope = SnapshotEnvelopeSchema.safeParse(JSON.parse(readFileSync(frozenPath, "utf8")))
    } catch {
      continue
    }
    if (!envelope.success) continue
    const evidenceRef = `inbox/${args.runId}/${fileName}`
    for (const item of envelope.data.items) {
      if (item.freshnessTier === "expired") continue
      const author = independentAuthorKey(item)
      const addresses = extractAddressesFromText(item.text)
      for (const address of addresses) {
        const chain = resolveHintChain(item.text, address)
        if (!chain) continue
        const chainEntry = getChain(chain)
        if (!chainEntry) continue
        if (!validateAddress(chainEntry.addressFormat, address)) continue
        const key = `${chain}:${address}`.toLowerCase()
        let acc = byKey.get(key)
        if (!acc) {
          acc = {
            chain,
            tokenAddress: address,
            authors: new Set(),
            evidenceRefs: new Set(),
          }
          byKey.set(key, acc)
        }
        acc.authors.add(author)
        acc.evidenceRefs.add(evidenceRef)
      }
    }
  }

  const state = new StateStore(join(args.agentRoot, "state"))
  const watchlistKeys = new Set(
    state.loadWatchlist().entries.map((entry) => (
      `${entry.identity.chain}:${entry.identity.tokenAddress}`.toLowerCase()
    )),
  )
  const queueKeys = new Set(
    state.loadResearchQueue().entries
      .filter((entry) => entry.chain && entry.tokenAddress)
      .map((entry) => dedupeKeyFor({
        subject: entry.subject,
        chain: entry.chain,
        tokenAddress: entry.tokenAddress,
      })),
  )

  const hints: SocialResearchHint[] = []
  for (const [key, acc] of byKey) {
    if (acc.authors.size < 2) continue
    if (watchlistKeys.has(key) || queueKeys.has(key)) continue
    const evidenceRefs = [...acc.evidenceRefs].sort()
    const hit = scanSealedEvidence({
      layout: args.layout,
      runId: args.runId,
      chain: acc.chain,
      tokenAddress: acc.tokenAddress,
      evidenceRefs,
    })
    if ("error" in hit) continue
    if (hit.authors.size < 2) continue
    hints.push({
      chain: acc.chain,
      tokenAddress: acc.tokenAddress,
      authorCount: hit.authors.size,
      authors: [...hit.authors].sort().slice(0, 32),
      evidenceRefs,
    })
  }

  return hints
    .sort((a, b) => {
      if (b.authorCount !== a.authorCount) return b.authorCount - a.authorCount
      return `${a.chain}:${a.tokenAddress}`.localeCompare(`${b.chain}:${b.tokenAddress}`)
    })
    .slice(0, max)
}

/** Path-only host hint for list-scan / farcaster-scan (no scraped tweet text). */
export async function writeResearchCandidatesHint(args: Readonly<{
  writer: SnapshotWriter
  runId: string
  fetchedAt: string
  hints: readonly SocialResearchHint[]
}>): Promise<void> {
  const lines = args.hints.length > 0
    ? args.hints.map((hint) => (
      [
        `chain=${hint.chain}`,
        `token=${hint.tokenAddress}`,
        `authors=${hint.authorCount}`,
        `evidence=${hint.evidenceRefs.join(",")}`,
      ].join(" ")
    ))
    : ["candidates=(none)"]
  await args.writer.writeInbox(args.runId, "research-candidates-hint", {
    source: "host.research-candidates-hint",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: lines.map((text, index) => ({
      provenance: `${args.runId}:research-candidates-hint:${index}`,
      text,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live" as const,
    })),
  })
}

function addressAppearsVerbatim(text: string, chain: string, tokenAddress: string): boolean {
  const addr = tokenAddress
  if (!text.includes(addr)) return false
  const chained = `${chain}:${tokenAddress}`
  if (text.includes(chained)) return true
  // Address alone is enough when the host also verifies chain support
  return true
}

type SealedHit = Readonly<{
  authors: ReadonlySet<string>
  expiredOnly: boolean
  liveOrStale: boolean
}>

function scanSealedEvidence(args: Readonly<{
  layout: ArchiveLayout
  runId: string
  chain: string
  tokenAddress: string
  evidenceRefs: readonly string[]
}>): SealedHit | { error: string } {
  const frozenInbox = join(runArchiveDir(args.layout, args.runId), "inbox")
  if (!existsSync(frozenInbox)) return { error: "sealed-inbox-missing" }

  const authors = new Set<string>()
  let seen = false
  let liveOrStale = false
  let expiredOnly = true

  for (const ref of args.evidenceRefs) {
    const inboxMatch = /^inbox\/([^/]+)\/([^/]+)$/u.exec(ref)
    if (!inboxMatch) return { error: "evidence-ref-unsupported" }
    if (inboxMatch[1] !== args.runId) return { error: "evidence-ref-cross-run" }
    const fileName = inboxMatch[2]!
    if (fileName.includes("..") || fileName.includes("\0") || fileName.includes("/")) {
      return { error: "evidence-ref-traversal" }
    }
    const frozenPath = join(frozenInbox, fileName)
    if (!existsSync(frozenPath)) return { error: "evidence-ref-not-frozen" }

    let envelope
    try {
      envelope = SnapshotEnvelopeSchema.safeParse(JSON.parse(readFileSync(frozenPath, "utf8")))
    } catch {
      return { error: "evidence-ref-unreadable" }
    }
    if (!envelope.success) return { error: "evidence-ref-not-snapshot" }

    for (const item of envelope.data.items) {
      if (!addressAppearsVerbatim(item.text, args.chain, args.tokenAddress)) continue
      seen = true
      if (item.freshnessTier === "expired") continue
      expiredOnly = false
      liveOrStale = true
      authors.add(independentAuthorKey(item))
    }
  }

  if (!seen) return { error: "address-not-in-evidence" }
  if (!liveOrStale && expiredOnly) return { error: "evidence-expired" }
  return { authors, expiredOnly: false, liveOrStale }
}

function rejectReasonForCandidate(
  candidate: ResearchCandidate,
  args: Readonly<{
    layout: ArchiveLayout
    runId: string
    queueKeys: ReadonlySet<string>
    watchlistKeys: ReadonlySet<string>
    acceptedKeys: ReadonlySet<string>
    acceptedCount: number
  }>,
): string | undefined {
  if (args.acceptedCount >= MAX_RESEARCH_CANDIDATES_PER_RUN) return "over-cap"
  if (!getChain(candidate.chain)) return "unsupported-chain"
  if (!/^[A-Za-z0-9]+$/u.test(candidate.tokenAddress)) return "malformed-address"
  // Ticker-only nominations cannot pass schema; keep an explicit guard for invented symbols
  if (!candidate.tokenAddress || candidate.tokenAddress.length < 32) return "ticker-only"

  const key = `${candidate.chain}:${candidate.tokenAddress}`.toLowerCase()
  if (args.watchlistKeys.has(key)) return "duplicated-watchlist"
  if (args.queueKeys.has(key) || args.acceptedKeys.has(key)) return "duplicated-queue"

  const hit = scanSealedEvidence({
    layout: args.layout,
    runId: args.runId,
    chain: candidate.chain,
    tokenAddress: candidate.tokenAddress,
    evidenceRefs: candidate.evidenceRefs,
  })
  if ("error" in hit) return hit.error
  if (hit.authors.size < 2) return "insufficient-authors"
  return undefined
}

function clusterCountFromEvidence(
  layout: ArchiveLayout,
  runId: string,
  chain: string,
  tokenAddress: string,
  evidenceRefs: readonly string[],
): number {
  const hit = scanSealedEvidence({ layout, runId, chain, tokenAddress, evidenceRefs })
  if ("error" in hit) return 0
  return hit.authors.size
}

function emptyReceipt(runId: string, nowIso: string): ResearchCandidateReceipt {
  return ResearchCandidateReceiptSchema.parse({
    schema: 1,
    runId,
    validatedAt: nowIso,
    accepted: [],
    rejected: [],
  })
}

function expiryIso(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) + days * 86_400_000).toISOString()
}

/**
 * Validate `reports/<runId>/research-candidates.json` and enqueue at most three
 * evidence-bound canonical identities. Never mutates watchlist, decisions, ledger, or wallets.
 */
export async function validateAndEnqueueResearchCandidates(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  runId: string
  nowIso: string
  dryRun?: boolean
}>): Promise<ResearchCandidateReceipt> {
  const receiptPath = join(runArchiveDir(args.layout, args.runId), "research-candidates-receipt.json")
  const proposalPath = researchCandidatesPath(args.agentRoot, args.runId)

  if (!existsSync(proposalPath)) {
    const receipt = emptyReceipt(args.runId, args.nowIso)
    await writeJsonRecordFsync(receiptPath, receipt as never)
    return receipt
  }

  let parsed
  try {
    parsed = ResearchCandidateFileSchema.safeParse(JSON.parse(readFileSync(proposalPath, "utf8")))
  } catch {
    const receipt = ResearchCandidateReceiptSchema.parse({
      schema: 1,
      runId: args.runId,
      validatedAt: args.nowIso,
      accepted: [],
      rejected: [{ reason: "malformed-json" }],
    })
    await writeJsonRecordFsync(receiptPath, receipt as never)
    return receipt
  }

  if (!parsed.success || parsed.data.runId !== args.runId) {
    const receipt = ResearchCandidateReceiptSchema.parse({
      schema: 1,
      runId: args.runId,
      validatedAt: args.nowIso,
      accepted: [],
      rejected: [{ reason: parsed.success ? "runId-mismatch" : "malformed-schema" }],
    })
    await writeJsonRecordFsync(receiptPath, receipt as never)
    return receipt
  }

  const config = loadConfig()
  const state = new StateStore(join(args.agentRoot, "state"))
  let queue = state.loadResearchQueue()
  const watchlistKeys = new Set(
    state.loadWatchlist().entries.map((entry) => (
      `${entry.identity.chain}:${entry.identity.tokenAddress}`.toLowerCase()
    )),
  )
  const queueKeys = new Set(
    queue.entries
      .filter((entry) => entry.chain && entry.tokenAddress)
      .map((entry) => dedupeKeyFor({
        subject: entry.subject,
        chain: entry.chain,
        tokenAddress: entry.tokenAddress,
      })),
  )

  const accepted: ResearchCandidateReceipt["accepted"] = []
  const rejected: ResearchCandidateReceipt["rejected"] = []
  const acceptedKeys = new Set<string>()
  const seenCandidateIds = new Set<string>()

  for (const candidate of parsed.data.candidates) {
    if (seenCandidateIds.has(candidate.candidateId)) {
      rejected.push({ candidateId: candidate.candidateId, reason: "duplicated-candidate-id" })
      continue
    }
    seenCandidateIds.add(candidate.candidateId)

    const reason = rejectReasonForCandidate(candidate, {
      layout: args.layout,
      runId: args.runId,
      queueKeys,
      watchlistKeys,
      acceptedKeys,
      acceptedCount: accepted.length,
    })
    if (reason) {
      rejected.push({ candidateId: candidate.candidateId, reason })
      continue
    }

    const clusterCount = clusterCountFromEvidence(
      args.layout,
      args.runId,
      candidate.chain,
      candidate.tokenAddress,
      candidate.evidenceRefs,
    )
    const subject = `${candidate.chain}:${candidate.tokenAddress}`
    const queueId = `rq-social-${args.runId}-${candidate.candidateId}`.slice(0, 128)
    const entry: ResearchQueueEntry = ResearchQueueEntrySchema.parse({
      schema: 1,
      queueId,
      subject,
      chain: candidate.chain,
      tokenAddress: candidate.tokenAddress,
      ...(candidate.symbolDisplay ? { symbolDisplay: candidate.symbolDisplay } : {}),
      resolution: "pending",
      priority: 50,
      firstSeen: args.nowIso,
      enqueuedAt: args.nowIso,
      enqueuedBy: `research-candidates:${args.runId}`,
      trigger: "social",
      expiresAt: expiryIso(args.nowIso, config.research.queue_expiry_days),
      provenance: [
        `research-candidates:${candidate.candidateId}`,
        ...candidate.evidenceRefs,
      ].slice(0, 32),
      clusterCount: Math.max(2, clusterCount),
      security: { status: "pending", flags: [] },
      status: "pending",
      reason: candidate.reason.slice(0, 280),
    })

    if (!args.dryRun) {
      queue = enqueueResearch(queue, entry, config.research.daily_cap)
    }
    const key = `${candidate.chain}:${candidate.tokenAddress}`.toLowerCase()
    acceptedKeys.add(key)
    queueKeys.add(key)
    accepted.push({
      candidateId: candidate.candidateId,
      queueId,
      chain: candidate.chain,
      tokenAddress: candidate.tokenAddress,
      clusterCount: entry.clusterCount,
    })
  }

  if (!args.dryRun && accepted.length > 0) {
    await state.saveResearchQueue(queue)
  }

  const receipt = ResearchCandidateReceiptSchema.parse({
    schema: 1,
    runId: args.runId,
    validatedAt: args.nowIso,
    accepted,
    rejected,
  })
  await writeJsonRecordFsync(receiptPath, receipt as never)
  const reportCopy = join(args.agentRoot, "reports", args.runId, "research-candidates-receipt.json")
  const reportDir = resolveUnder(args.agentRoot, join("reports", args.runId))
  if (reportDir) {
    await writeAtomicFile(reportCopy, `${JSON.stringify(receipt, null, 2)}\n`)
  }
  return receipt
}
