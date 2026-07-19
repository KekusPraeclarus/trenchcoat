import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { SnapshotWriter } from "../lib/snapshot.js"
import { archiveLayout, runArchiveDir } from "../lib/archive.js"
import {
  SnapshotEnvelopeSchema,
  SNAPSHOT_MAX_ITEMS,
  XFypEligibleManifestSchema,
  type XFypEligibleManifest,
} from "../contracts/schemas.js"
import { capEnvelopeItems } from "./review-collect.js"

const ITEM_TEXT_RE = /^postId=(\d{5,25}) author=([A-Za-z0-9_]{1,15})$/u

export function manifestFromEnvelope(raw: unknown): XFypEligibleManifest {
  const envelope = SnapshotEnvelopeSchema.parse(raw)
  const posts: Array<{ postId: string, author: string }> = []
  let runId: string | undefined
  for (const item of envelope.items) {
    const match = ITEM_TEXT_RE.exec(item.text.trim())
    if (!match) continue
    posts.push({ postId: match[1]!, author: match[2]!.toLowerCase() })
    const provMatch = /^([^:]+):x-fyp-eligible:/u.exec(item.provenance)
    if (provMatch) runId = provMatch[1]
  }
  if (posts.length === 0 && envelope.items.length > 0) {
    throw new Error("x-fyp-eligible snapshot contained no parseable posts")
  }
  return XFypEligibleManifestSchema.parse({
    schema: 1,
    runId: runId ?? "unknown",
    collectedAt: envelope.fetchedAt,
    posts,
  })
}

export async function writeXFypEligibleSnapshot(args: Readonly<{
  writer: SnapshotWriter
  runId: string
  fetchedAt: string
  posts: readonly Readonly<{ id: string, author: string }>[]
  truncatedBy?: number
}>): Promise<void> {
  const items = args.posts.map((post) => ({
    provenance: `${args.runId}:x-fyp-eligible:${post.id}`,
    text: `postId=${post.id} author=${post.author}`,
    ts: args.fetchedAt,
    ageSec: 0,
    freshnessTier: "live" as const,
    dedupeKey: post.id,
  }))
  const envelopeItems = args.truncatedBy && args.truncatedBy > 0
    ? [
      ...items,
      {
        provenance: `${args.runId}:x-fyp-eligible:truncated`,
        text: `truncated=${args.truncatedBy}`,
        ts: args.fetchedAt,
        ageSec: 0,
        freshnessTier: "live" as const,
      },
    ]
    : capEnvelopeItems(
      items,
      (truncatedBy) => ({
        provenance: `${args.runId}:x-fyp-eligible:truncated`,
        text: `truncated=${truncatedBy}`,
        ts: args.fetchedAt,
        ageSec: 0,
        freshnessTier: "live" as const,
      }),
    ).items
  await args.writer.writeInbox(args.runId, "x-fyp-eligible", {
    source: "host.x-fyp-eligible",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: envelopeItems,
  })
}

export function loadXFypEligibleManifest(
  agentRoot: string,
  archiveRoot: string,
  runId: string,
): XFypEligibleManifest | undefined {
  const candidates = [
    join(agentRoot, "inbox", runId, "x-fyp-eligible.json"),
    join(runArchiveDir(archiveLayout(archiveRoot), runId), "inbox", "x-fyp-eligible.json"),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      return manifestFromEnvelope(JSON.parse(readFileSync(path, "utf8")))
    } catch {
      // try next location
    }
  }
  return undefined
}
