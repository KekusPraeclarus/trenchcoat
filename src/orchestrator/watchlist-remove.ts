import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { WorkspaceLock, agentLockPath } from "../lib/lock.js"
import { StateStore } from "../lib/state.js"
import { ensureArchive, writeJsonRecordFsync } from "../lib/archive.js"
import { sha256Bytes } from "../lib/fs-atomic.js"
import { systemClock } from "../lib/clock.js"
import { dedupeKeyFor } from "../lib/research-queue.js"
import { reconcileIndex } from "./index-reconcile.js"

const OPEN_LEDGER = new Set(["entry-pending", "open", "exit-pending"])
const REMOVABLE = new Set(["ignored", "revisit", "dropped"])
const REASON_MAX = 280

export type WatchlistRemoveReport = Readonly<{
  status: "removed" | "refused"
  identityKey: string
  subject: string
  reason: string
  refusedReason?: string
  priorStatus?: string
  priorDecisionId?: string
  decisionId?: string
  removedQueueIds?: readonly string[]
  receiptHash?: `sha256:${string}`
  beforeWatchlistHash?: `sha256:${string}`
  afterWatchlistHash?: `sha256:${string}`
}>

function parseIdentityKey(raw: string): { chain: string; tokenAddress: string } {
  const idx = raw.indexOf(":")
  if (idx <= 0 || idx === raw.length - 1) {
    throw new TypeError("identity must be chain:tokenAddress")
  }
  return {
    chain: raw.slice(0, idx),
    tokenAddress: raw.slice(idx + 1),
  }
}

function normalizeSubject(value: string): string {
  return value.trim().toUpperCase()
}

export async function removeWatchlistEntry(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  identityKey: string
  subject: string
  reason: string
}>): Promise<WatchlistRemoveReport> {
  const reason = args.reason.replace(/\s+/gu, " ").trim().slice(0, REASON_MAX)
  if (!reason) throw new TypeError("reason is required")
  const subject = normalizeSubject(args.subject)
  if (!subject) throw new TypeError("subject is required")
  const { chain, tokenAddress } = parseIdentityKey(args.identityKey)
  const identityKey = `${chain}:${tokenAddress}`

  const lock = new WorkspaceLock(agentLockPath(args.agentRoot))
  if (!lock.tryAcquire()) {
    return {
      status: "refused",
      identityKey,
      subject,
      reason,
      refusedReason: "workspace-lock-busy",
    }
  }

  const store = new StateStore(join(args.agentRoot, "state"))
  const beforeWatchlist = store.loadWatchlist()
  const beforeHash = sha256Bytes(`${JSON.stringify(beforeWatchlist)}\n`)
  const entry = beforeWatchlist.entries.find((e) => (
    e.identity.chain === chain
    && e.identity.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
  ))

  try {
    if (!entry) {
      return {
        status: "refused",
        identityKey,
        subject,
        reason,
        refusedReason: "not-found",
        beforeWatchlistHash: beforeHash,
      }
    }
    if (normalizeSubject(entry.identity.symbolDisplay) !== subject) {
      return {
        status: "refused",
        identityKey,
        subject,
        reason,
        refusedReason: "subject-mismatch",
        priorStatus: entry.status,
        ...(entry.lastDecisionId ? { priorDecisionId: entry.lastDecisionId } : {}),
        beforeWatchlistHash: beforeHash,
      }
    }
    if (entry.status === "tracking" || entry.status === "watching") {
      return {
        status: "refused",
        identityKey,
        subject,
        reason,
        refusedReason: "active-status-use-drop",
        priorStatus: entry.status,
        ...(entry.lastDecisionId ? { priorDecisionId: entry.lastDecisionId } : {}),
        beforeWatchlistHash: beforeHash,
      }
    }
    if (!REMOVABLE.has(entry.status)) {
      return {
        status: "refused",
        identityKey,
        subject,
        reason,
        refusedReason: "status-not-removable",
        priorStatus: entry.status,
        ...(entry.lastDecisionId ? { priorDecisionId: entry.lastDecisionId } : {}),
        beforeWatchlistHash: beforeHash,
      }
    }

    const ledger = store.loadLedger()
    const open = ledger.positions.find((p) => (
      p.identity.chain === chain
      && p.identity.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
      && OPEN_LEDGER.has(p.status)
    ))
    if (open) {
      return {
        status: "refused",
        identityKey,
        subject,
        reason,
        refusedReason: "open-ledger-position",
        priorStatus: entry.status,
        ...(entry.lastDecisionId ? { priorDecisionId: entry.lastDecisionId } : {}),
        beforeWatchlistHash: beforeHash,
      }
    }

    const nowIso = systemClock.nowIso()
    const decisionId = `dec-op-remove-${nowIso.replace(/[-:.TZ]/gu, "").slice(0, 14)}`
    const queue = store.loadResearchQueue()
    const identityDedupe = dedupeKeyFor({ chain, tokenAddress, subject })
    const subjectDedupe = `subject:${subject.toLowerCase()}`
    const removedEntries = queue.entries.filter((q) => {
      const key = dedupeKeyFor(q)
      if (key === identityDedupe) return true
      // Explicit --subject match clears unbound duplicate for this audited op only
      return key === subjectDedupe && normalizeSubject(q.subject) === subject
    })
    const removedQueueIds = removedEntries.map((e) => e.queueId)
    const nextQueue = {
      ...queue,
      entries: queue.entries.filter((q) => !removedQueueIds.includes(q.queueId)),
    }
    const nextWatchlist = {
      ...beforeWatchlist,
      entries: beforeWatchlist.entries.filter((e) => (
        !(e.identity.chain === chain
          && e.identity.tokenAddress.toLowerCase() === tokenAddress.toLowerCase())
      )),
    }

    const tombstone = [
      `## ${decisionId} — operator-remove ${identityKey}`,
      `- date: ${nowIso}  run: operator-cli`,
      `- prior-status: ${entry.status}`,
      `- prior-decision: ${entry.lastDecisionId ?? "none"}`,
      `- subject: ${subject}`,
      `- reason: ${reason}`,
      `- removed-queue-ids: [${removedQueueIds.join(", ")}]`,
      "",
    ].join("\n")

    const archive = await ensureArchive(args.archiveRoot)
    mkdirSync(join(archive.decisions), { recursive: true, mode: 0o700 })

    try {
      await store.saveWatchlist(nextWatchlist)
      await store.saveResearchQueue(nextQueue)
      await store.appendDecision(tombstone)
      await reconcileIndex({
        agentRoot: args.agentRoot,
        state: store,
        nowIso,
      })
      const afterWatchlist = store.loadWatchlist()
      const afterHash = sha256Bytes(`${JSON.stringify(afterWatchlist)}\n`)
      const receiptHash = await writeJsonRecordFsync(
        join(archive.decisions, `${decisionId}.json`),
        {
          schema: 1,
          kind: "operator-watchlist-remove",
          decisionId,
          identityKey,
          subject,
          reason,
          priorStatus: entry.status,
          priorDecisionId: entry.lastDecisionId ?? null,
          removedQueueIds,
          beforeWatchlistHash: beforeHash,
          afterWatchlistHash: afterHash,
          at: nowIso,
        },
      )
      return {
        status: "removed",
        identityKey,
        subject,
        reason,
        priorStatus: entry.status,
        ...(entry.lastDecisionId ? { priorDecisionId: entry.lastDecisionId } : {}),
        decisionId,
        removedQueueIds,
        receiptHash,
        beforeWatchlistHash: beforeHash,
        afterWatchlistHash: afterHash,
      }
    } catch (error) {
      await store.saveWatchlist(beforeWatchlist)
      await store.saveResearchQueue(queue)
      throw error
    }
  } finally {
    lock.release()
  }
}
