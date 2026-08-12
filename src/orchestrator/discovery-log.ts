import type { ArchiveLayout } from "../lib/archive.js"
import {
  DiscoveryLogEntrySchema,
  type DiscoveryLogEntry,
  type ResearchQueueEntry,
  type ResearchTrigger,
} from "../contracts/schemas.js"
import { sha256Json } from "../lib/canonical-json.js"
import { appendJsonl } from "./scorecard.js"
import { join } from "node:path"

export function discoveryLogPath(layout: ArchiveLayout): string {
  return join(layout.root, "discovery-log.jsonl")
}

export async function appendDiscoveryLog(
  layout: ArchiveLayout,
  entry: DiscoveryLogEntry,
): Promise<void> {
  const parsed = DiscoveryLogEntrySchema.parse(entry)
  await appendJsonl(discoveryLogPath(layout), parsed)
}

function triggerForQueueEntry(entry: Readonly<ResearchQueueEntry>): ResearchTrigger {
  return entry.trigger
}

function recordIdFor(
  reason: string,
  entry: Readonly<ResearchQueueEntry>,
  nowIso: string,
): string {
  const digest = sha256Json({
    kind: "discovery-queue-sweep",
    reason,
    queueId: entry.queueId,
    status: entry.status,
    at: nowIso,
  }).replace(/^sha256:/u, "")
  return `dl-q-${digest.slice(0, 40)}`
}

/** Append discovery-log rows for queue expiry or reject sweeps. */
export async function appendQueueSweepDiscoveryLogs(
  layout: ArchiveLayout,
  entries: readonly ResearchQueueEntry[],
  reason: "expired" | "rejected" | "security-fail",
  nowIso: string,
): Promise<void> {
  for (const entry of entries) {
    const source = reason === "expired"
      ? "queue-expiry" as const
      : "queue-reject" as const
    await appendDiscoveryLog(layout, {
      schema: 1,
      recordId: recordIdFor(reason, entry, nowIso),
      recordedAt: nowIso,
      trigger: triggerForQueueEntry(entry),
      ...(entry.chain ? { chain: entry.chain } : {}),
      ...(entry.tokenAddress ? { tokenAddress: entry.tokenAddress } : {}),
      ...(entry.pairAddress ? { pairAddress: entry.pairAddress } : {}),
      subject: entry.subject.slice(0, 256),
      reason: reason.slice(0, 120),
      source,
      securityStatus: entry.security.status,
      surfacedAt: entry.firstSeen,
    })
  }
}
