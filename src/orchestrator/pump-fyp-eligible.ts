import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { SnapshotWriter } from "../lib/snapshot.js"
import { archiveLayout, runArchiveDir } from "../lib/archive.js"
import {
  SnapshotEnvelopeSchema,
  SNAPSHOT_MAX_ITEMS,
  PumpFypEligibleManifestSchema,
  type PumpFypEligibleManifest,
} from "../contracts/schemas.js"
import { capEnvelopeItems } from "./review-collect.js"

const ITEM_TEXT_RE = /^itemId=([A-Za-z0-9._-]{1,128}) author=([A-Za-z0-9._-]{1,64})$/u

export function pumpManifestFromEnvelope(raw: unknown): PumpFypEligibleManifest {
  const envelope = SnapshotEnvelopeSchema.parse(raw)
  const items: Array<{ itemId: string, author: string }> = []
  let runId: string | undefined
  for (const item of envelope.items) {
    const match = ITEM_TEXT_RE.exec(item.text.trim())
    if (!match) continue
    items.push({ itemId: match[1]!, author: match[2]! })
    const provMatch = /^([^:]+):pump-fyp-eligible:/u.exec(item.provenance)
    if (provMatch) runId = provMatch[1]
  }
  if (items.length === 0 && envelope.items.length > 0) {
    throw new Error("pump-fyp-eligible snapshot contained no parseable items")
  }
  return PumpFypEligibleManifestSchema.parse({
    schema: 1,
    runId: runId ?? "unknown",
    collectedAt: envelope.fetchedAt,
    items: items.slice(0, SNAPSHOT_MAX_ITEMS),
  })
}

export async function writePumpFypEligibleSnapshot(args: Readonly<{
  writer: SnapshotWriter
  runId: string
  fetchedAt: string
  items: readonly Readonly<{ itemId: string, author: string }>[]
  truncatedBy?: number
}>): Promise<void> {
  const mapped = args.items.map((item) => ({
    provenance: `${args.runId}:pump-fyp-eligible:${item.itemId}`,
    text: `itemId=${item.itemId} author=${item.author}`,
    ts: args.fetchedAt,
    ageSec: 0,
    freshnessTier: "live" as const,
    dedupeKey: item.itemId,
  }))
  const capped = capEnvelopeItems(
    mapped,
    (truncatedBy) => ({
      provenance: `${args.runId}:pump-fyp-eligible:truncated`,
      text: `truncated=${args.truncatedBy ?? truncatedBy}`,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live" as const,
    }),
  )
  await args.writer.writeInbox(args.runId, "pump-fyp-eligible", {
    source: "host.pump-fyp-eligible",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: capped.items,
  })
}

export function loadPumpFypEligibleManifest(
  agentRoot: string,
  archiveRoot: string,
  runId: string,
): PumpFypEligibleManifest | undefined {
  const candidates = [
    join(agentRoot, "inbox", runId, "pump-fyp-eligible.json"),
    join(runArchiveDir(archiveLayout(archiveRoot), runId), "inbox", "pump-fyp-eligible.json"),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      return pumpManifestFromEnvelope(JSON.parse(readFileSync(path, "utf8")))
    } catch {
      // try next location
    }
  }
  return undefined
}
