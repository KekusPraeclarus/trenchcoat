import { z } from "zod"
import { sha256Json } from "../lib/canonical-json.js"
import {
  FcSourceLifecycleFileSchema,
  type FcSourceCandidate,
  type FcSourceLifecycleFile,
  type FcSourceLifecycleTransition,
} from "../contracts/schemas.js"
import {
  normalizeFcHandle,
  sourceIdForFcHandle,
} from "./fc-lifecycle.js"

const FORBIDDEN_SEED_KEYS = [
  "signer",
  "signerUuid",
  "signer_uuid",
  "mnemonic",
  "privateKey",
  "private_key",
  "apiKey",
  "api_key",
  "inbox",
  "reports",
  "provenance",
  "model",
] as const

export const FcSourceSeedEntrySchema = z.object({
  handle: z.string().min(1).max(32),
  fid: z.number().int().positive(),
  status: z.enum(["managed", "probation"]).default("managed"),
})
export type FcSourceSeedEntry = z.infer<typeof FcSourceSeedEntrySchema>

export const FcSourceSeedFileSchema = z.object({
  schema: z.literal(1),
  sources: z.array(FcSourceSeedEntrySchema).min(1).max(5_000),
})
export type FcSourceSeedFile = z.infer<typeof FcSourceSeedFileSchema>

function assertNoForbiddenKeys(raw: unknown, path = ""): void {
  if (raw === null || typeof raw !== "object") return
    for (const [key, value] of Object.entries(raw)) {
    const full = path ? `${path}.${key}` : key
    if (FORBIDDEN_SEED_KEYS.some((forbidden) => key.toLowerCase() === forbidden.toLowerCase())) {
      throw new TypeError(`Forbidden seed field ${full}`)
    }
    assertNoForbiddenKeys(value, full)
  }
}

export function parseFcSourceSeedFile(raw: unknown): FcSourceSeedFile {
  assertNoForbiddenKeys(raw)
  return FcSourceSeedFileSchema.parse(raw)
}

export function normalizeFcSourceSeedEntries(
  entries: readonly FcSourceSeedEntry[],
): FcSourceSeedEntry[] {
  const byFid = new Map<number, FcSourceSeedEntry>()
  for (const entry of entries) {
    const handle = normalizeFcHandle(entry.handle)
    if (!handle) throw new TypeError(`Invalid Farcaster handle ${entry.handle}`)
    const normalized: FcSourceSeedEntry = {
      handle,
      fid: entry.fid,
      status: entry.status,
    }
    const existing = byFid.get(normalized.fid)
    if (existing && existing.handle !== normalized.handle) {
      throw new TypeError(`Conflicting handles for fid ${normalized.fid}`)
    }
    byFid.set(normalized.fid, normalized)
  }
  return [...byFid.values()].sort((a, b) => (
    a.fid === b.fid ? a.handle.localeCompare(b.handle) : a.fid - b.fid
  ))
}

function transitionId(args: Readonly<{
  sourceId: string
  action: "promoted" | "seeded"
  runId: string
}>): `sha256:${string}` {
  return sha256Json(args)
}

export function seedFcSourceLifecycle(args: Readonly<{
  entries: readonly FcSourceSeedEntry[]
  existing: FcSourceLifecycleFile
  nowIso: string
  runId: string
}>): Readonly<{
  file: FcSourceLifecycleFile
  transitions: FcSourceLifecycleTransition[]
  added: number
  updated: number
  skipped: number
}> {
  const entries = normalizeFcSourceSeedEntries(args.entries)
  const byId = new Map(args.existing.candidates.map((c) => [c.sourceId, c]))
  const transitions: FcSourceLifecycleTransition[] = []
  let added = 0
  let updated = 0
  let skipped = 0

  for (const entry of entries) {
    const sourceId = sourceIdForFcHandle(entry.handle)
    const evidenceHash = sha256Json({
      kind: "operator-fc-seed",
      sourceId,
      handle: entry.handle,
      fid: entry.fid,
      runId: args.runId,
    })
    const existing = byId.get(sourceId)
    if (existing) {
      if (existing.fid !== entry.fid) {
        throw new TypeError(`Seed fid ${entry.fid} conflicts with existing ${existing.fid} for ${sourceId}`)
      }
      if (existing.status === entry.status) {
        skipped += 1
        byId.set(sourceId, {
          ...existing,
          lastSeenAt: args.nowIso,
        })
        continue
      }
      updated += 1
      const fromStatus = existing.status
      const toStatus = entry.status
      transitions.push({
        schema: 1,
        transitionId: transitionId({ sourceId, action: "seeded", runId: args.runId }),
        sourceId,
        handle: entry.handle,
        fid: entry.fid,
        action: toStatus === "managed" ? "promoted" : "demoted",
        reasonCode: "operator-seed",
        occurredAt: args.nowIso,
        epochId: args.runId,
        evidenceHash,
        fromStatus,
        toStatus,
      })
      byId.set(sourceId, {
        ...existing,
        status: entry.status,
        lastSeenAt: args.nowIso,
        ...(toStatus === "managed" ? { promotedAt: args.nowIso } : { demotedAt: args.nowIso }),
      })
      continue
    }

    added += 1
    const candidate: FcSourceCandidate = {
      schema: 1,
      sourceId,
      handle: entry.handle,
      fid: entry.fid,
      discoveredFrom: "fc-fyp",
      firstSeenAt: args.nowIso,
      lastSeenAt: args.nowIso,
      status: entry.status,
      consecutiveBelowFloorEpochs: 0,
      hardDocked: false,
      evidenceHash,
      ...(entry.status === "managed" ? { promotedAt: args.nowIso } : {}),
    }
    if (entry.status === "managed") {
      transitions.push({
        schema: 1,
        transitionId: transitionId({ sourceId, action: "seeded", runId: args.runId }),
        sourceId,
        handle: entry.handle,
        fid: entry.fid,
        action: "promoted",
        reasonCode: "operator-seed",
        occurredAt: args.nowIso,
        epochId: args.runId,
        evidenceHash,
        fromStatus: "probation",
        toStatus: "managed",
      })
    }
    byId.set(sourceId, candidate)
  }

  const priorIds = new Set(args.existing.transitions.map((t) => t.transitionId))
  const freshTransitions = transitions.filter((t) => !priorIds.has(t.transitionId))

  return {
    file: FcSourceLifecycleFileSchema.parse({
      ...args.existing,
      candidates: [...byId.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
      transitions: [...args.existing.transitions, ...freshTransitions],
      pendingTransitionIds: [
        ...new Set([
          ...args.existing.pendingTransitionIds,
          ...freshTransitions.map((t) => t.transitionId),
        ]),
      ],
    }),
    transitions: freshTransitions,
    added,
    updated,
    skipped,
  }
}
