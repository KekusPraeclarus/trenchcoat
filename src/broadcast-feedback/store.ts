import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { WorkspaceLock } from "../lib/lock.js"
import { broadcastFeedbackLayout, type BroadcastFeedbackLayout } from "./paths.js"
import {
  BroadcastFeedbackEventSchema,
  BroadcastFeedbackRecordSchema,
  PendingFollowupsFileSchema,
  type BroadcastFeedbackEvent,
  type BroadcastFeedbackRecord,
  type PendingFollowup,
  type PendingFollowupsFile,
} from "./schemas.js"

/**
 * Durable store for operator broadcast feedback. The ledger is append-only, so
 * the latest line per feedbackId is the current record. Every mutation holds
 * the feedback lock, because the Discord listener and the Telegram chat can
 * both write.
 */

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
}

function writeFileAtomic(path: string, body: string): void {
  ensureDir(dirname(path))
  const tmp = `${path}.tmp`
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, path)
}

export async function withFeedbackLock<T>(
  layout: BroadcastFeedbackLayout,
  fn: () => Promise<T>,
  opts?: Readonly<{ attempts?: number; delayMs?: number }>,
): Promise<T> {
  ensureDir(layout.root)
  const attempts = Math.max(1, opts?.attempts ?? 20)
  const delayMs = Math.max(10, opts?.delayMs ?? 250)
  const lock = new WorkspaceLock(layout.lock)
  for (let i = 0; i < attempts; i++) {
    if (lock.tryAcquire()) {
      try {
        return await fn()
      } finally {
        lock.release()
      }
    }
    if (i + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw new Error("broadcast feedback lock held")
}

export function readFeedbackLedger(
  layout: BroadcastFeedbackLayout,
): readonly BroadcastFeedbackEvent[] {
  if (!existsSync(layout.ledger)) return []
  const out: BroadcastFeedbackEvent[] = []
  for (const line of readFileSync(layout.ledger, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch {
      continue
    }
    const parsed = BroadcastFeedbackEventSchema.safeParse(raw)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

/** Latest record per feedbackId, in first-seen order */
export function currentFeedbackRecords(
  layout: BroadcastFeedbackLayout,
): readonly BroadcastFeedbackRecord[] {
  const byId = new Map<string, BroadcastFeedbackRecord>()
  for (const event of readFeedbackLedger(layout)) {
    byId.set(event.record.feedbackId, event.record)
  }
  return [...byId.values()]
}

export function findFeedbackRecord(
  layout: BroadcastFeedbackLayout,
  feedbackId: string,
): BroadcastFeedbackRecord | undefined {
  let found: BroadcastFeedbackRecord | undefined
  for (const event of readFeedbackLedger(layout)) {
    if (event.record.feedbackId === feedbackId) found = event.record
  }
  return found
}

export function appendFeedbackEvent(
  layout: BroadcastFeedbackLayout,
  event: BroadcastFeedbackEvent,
): void {
  const validated = BroadcastFeedbackEventSchema.parse({
    ...event,
    record: BroadcastFeedbackRecordSchema.parse(event.record),
  })
  ensureDir(layout.root)
  appendFileSync(layout.ledger, `${JSON.stringify(validated)}\n`, { mode: 0o600 })
}

export function readPendingFollowups(
  layout: BroadcastFeedbackLayout,
): PendingFollowupsFile {
  if (!existsSync(layout.pendingFollowups)) return { schema: 1, pending: [] }
  try {
    const parsed = PendingFollowupsFileSchema.safeParse(
      JSON.parse(readFileSync(layout.pendingFollowups, "utf8")),
    )
    return parsed.success ? parsed.data : { schema: 1, pending: [] }
  } catch {
    return { schema: 1, pending: [] }
  }
}

export function writePendingFollowups(
  layout: BroadcastFeedbackLayout,
  pending: readonly PendingFollowup[],
): void {
  const file = PendingFollowupsFileSchema.parse({ schema: 1, pending: [...pending] })
  writeFileAtomic(layout.pendingFollowups, `${JSON.stringify(file, null, 2)}\n`)
}

/**
 * The newest pending follow-up. The Telegram reply carries no feedbackId, so
 * the host binds a bare reply to the most recent open request.
 */
export function newestPendingFollowup(
  layout: BroadcastFeedbackLayout,
  nowIso: string,
): PendingFollowup | undefined {
  const nowMs = Date.parse(nowIso)
  const open = readPendingFollowups(layout).pending
    .filter((entry) => Date.parse(entry.expiresAt) > nowMs)
    .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt))
  return open[0]
}

export { broadcastFeedbackLayout }
