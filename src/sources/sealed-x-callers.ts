import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  SnapshotEnvelopeSchema,
  type SourceCallEvent,
  type SourceDiscoveryOrigin,
  type SourceLifecycleFile,
} from "../contracts/schemas.js"
import type { ArchiveLayout } from "../lib/archive.js"
import { isXPostProvenance } from "../orchestrator/call-log.js"
import {
  isDiscoveryOrigin,
  normalizeHandle,
  registerDiscoveryCandidates,
  sourceIdForHandle,
} from "./lifecycle.js"

export const MIN_SEALED_X_CALLS = 10
export const MIN_SEALED_X_TOKENS = 5
const MAX_LIST_SCAN_RUNS = 60

export type SealedXCallerSighting = Readonly<{
  handle: string
  origin: SourceDiscoveryOrigin
}>

export type SealedXCallerRegisterReport = Readonly<{
  registered: number
  considered: number
  sighted: number
}>

function handleFromXProvenance(provenance: string): string | undefined {
  const match = provenance.match(/^(?:twitter|x):@([A-Za-z0-9_]{1,15})$/u)
  return match?.[1] ? normalizeHandle(match[1]) : undefined
}

function originFromListScanSnapshot(args: Readonly<{
  fileName: string
  source: string
}>): SourceDiscoveryOrigin | undefined {
  const blob = `${args.fileName} ${args.source}`.toLowerCase()
  if (blob.includes("operator-list-1")) return "operator-list-1"
  if (blob.includes("operator-list-2")) return "operator-list-2"
  if (
    blob.includes("twitter-home")
    || blob.includes("twitter.home")
    || blob.includes("twitter-fyp")
    || blob.includes("twitter.fyp")
    || blob.includes("for-you")
  ) {
    return "fyp"
  }
  return undefined
}

/** Authors seen on sealed FYP or operator-list snapshots. */
export function loadDiscoverySightingsFromArchive(
  layout: ArchiveLayout,
): SealedXCallerSighting[] {
  if (!existsSync(layout.runs)) return []
  const runIds = readdirSync(layout.runs)
    .filter((name) => name.startsWith("list-scan-"))
    .sort()
    .slice(-MAX_LIST_SCAN_RUNS)
  const seen = new Set<string>()
  const out: SealedXCallerSighting[] = []
  for (const runId of runIds) {
    const inbox = join(layout.runs, runId, "inbox")
    if (!existsSync(inbox)) continue
    for (const fileName of readdirSync(inbox)) {
      if (!fileName.startsWith("twitter-") || !fileName.endsWith(".json")) continue
      let envelope
      try {
        envelope = SnapshotEnvelopeSchema.parse(
          JSON.parse(readFileSync(join(inbox, fileName), "utf8")),
        )
      } catch {
        continue
      }
      const origin = originFromListScanSnapshot({
        fileName,
        source: envelope.source,
      })
      if (!origin || !isDiscoveryOrigin(origin)) continue
      for (const item of envelope.items) {
        const handle = handleFromXProvenance(item.provenance)
        if (!handle) continue
        const key = `${origin}:${handle.toLowerCase()}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ handle, origin })
      }
    }
  }
  return out
}

export function strongXCallersFromLog(
  events: readonly SourceCallEvent[],
): ReadonlyMap<string, Readonly<{ handle: string, calls: number, tokens: number }>> {
  const bySource = new Map<string, { handle: string, tokens: Set<string>, calls: number }>()
  for (const event of events) {
    if (!isXPostProvenance(event.provenance)) continue
    const handle = handleFromXProvenance(event.provenance)
    if (!handle) continue
    const sourceId = event.sourceId.startsWith("x_")
      ? event.sourceId
      : sourceIdForHandle(handle)
    const bucket = bySource.get(sourceId) ?? {
      handle,
      tokens: new Set<string>(),
      calls: 0,
    }
    bucket.calls += 1
    bucket.tokens.add(event.rawAddress.toLowerCase())
    bySource.set(sourceId, bucket)
  }
  const out = new Map<string, Readonly<{ handle: string, calls: number, tokens: number }>>()
  for (const [sourceId, bucket] of bySource) {
    if (bucket.calls < MIN_SEALED_X_CALLS || bucket.tokens.size < MIN_SEALED_X_TOKENS) {
      continue
    }
    out.set(sourceId, {
      handle: bucket.handle,
      calls: bucket.calls,
      tokens: bucket.tokens.size,
    })
  }
  return out
}

/**
 * Register strong X-post callers who also appear on a sealed FYP or operator
 * list snapshot. Home-only callers without that sighting stay out.
 */
export function registerSealedXCallers(
  file: SourceLifecycleFile,
  args: Readonly<{
    events: readonly SourceCallEvent[]
    sightings: readonly SealedXCallerSighting[]
    nowIso: string
  }>,
): Readonly<{ file: SourceLifecycleFile, report: SealedXCallerRegisterReport }> {
  const strong = strongXCallersFromLog(args.events)
  const originByHandle = new Map<string, SourceDiscoveryOrigin>()
  for (const sighting of args.sightings) {
    const handle = normalizeHandle(sighting.handle)
    if (!handle || !isDiscoveryOrigin(sighting.origin)) continue
    if (!originByHandle.has(handle.toLowerCase())) {
      originByHandle.set(handle.toLowerCase(), sighting.origin)
    }
  }
  const toRegister: SealedXCallerSighting[] = []
  for (const caller of strong.values()) {
    const origin = originByHandle.get(caller.handle.toLowerCase())
    if (!origin) continue
    toRegister.push({ handle: caller.handle, origin })
  }
  const next = registerDiscoveryCandidates(file, toRegister, args.nowIso)
  const before = new Set(file.candidates.map((c) => c.sourceId))
  const registered = next.candidates.filter((c) => !before.has(c.sourceId)).length
  return {
    file: next,
    report: {
      registered,
      considered: strong.size,
      sighted: originByHandle.size,
    },
  }
}
