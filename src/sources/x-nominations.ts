import { createHash } from "node:crypto"
import type { FomoLeaderboardEntry } from "../collectors/fomo/types.js"
import { normalizeXHandle } from "../collectors/fomo/mappers.js"

export type XSourceNominationStatus =
  | "pending"
  | "classifying"
  | "classified"
  | "insufficient-history"
  | "rejected"
  | "unreviewable"

export type XSourceNomination = Readonly<{
  nominationId: string
  fomoHandle: string
  xHandle: string
  matchBasis: "fomo-profile-link" | "same-handle"
  timeframe?: string
  rank?: number
  nominatedAt: string
  expiresAt: string
  status: XSourceNominationStatus
  attempts: number
  reviewAfter?: string
  classification?: "shiller" | "narrative" | "both" | "reject"
  classificationRunId?: string
}>

export type XSourceNominationsFile = Readonly<{
  schema: 1
  nominations: readonly XSourceNomination[]
}>

export function emptyXSourceNominations(): XSourceNominationsFile {
  return { schema: 1, nominations: [] }
}

export function nominationIdForHandle(xHandle: string): string {
  return createHash("sha256").update(xHandle.toLowerCase()).digest("hex").slice(0, 24)
}

export function resolveXHandleFromTrader(trader: FomoLeaderboardEntry): Readonly<{
  xHandle: string
  matchBasis: "fomo-profile-link" | "same-handle"
} | undefined> {
  if (trader.xHandle) {
    const handle = normalizeXHandle(trader.xHandle)
    if (!handle) return undefined
    return { xHandle: handle, matchBasis: "fomo-profile-link" }
  }
  const same = normalizeXHandle(trader.handle)
  if (!same) return undefined
  return { xHandle: same, matchBasis: "same-handle" }
}

export function upsertXSourceNominations(
  file: XSourceNominationsFile,
  args: Readonly<{
    traders: readonly FomoLeaderboardEntry[]
    nominatedAt: string
    maxPending: number
    requireProfileLink?: boolean
  }>,
): XSourceNominationsFile {
  const byId = new Map(file.nominations.map((item) => [item.nominationId, item]))
  const expiresAt = new Date(Date.parse(args.nominatedAt) + 7 * 86_400_000).toISOString()
  for (const trader of args.traders) {
    const resolved = resolveXHandleFromTrader(trader)
    if (!resolved) continue
    if (args.requireProfileLink && resolved.matchBasis !== "fomo-profile-link") continue
    const nominationId = nominationIdForHandle(resolved.xHandle)
    const existing = byId.get(nominationId)
    if (existing && existing.status !== "rejected" && existing.status !== "unreviewable") {
      byId.set(nominationId, {
        ...existing,
        nominatedAt: args.nominatedAt,
        expiresAt,
        ...(trader.rank !== undefined ? { rank: trader.rank } : {}),
      })
      continue
    }
    byId.set(nominationId, {
      nominationId,
      fomoHandle: trader.handle,
      xHandle: resolved.xHandle,
      matchBasis: resolved.matchBasis,
      timeframe: trader.timeframe,
      ...(trader.rank !== undefined ? { rank: trader.rank } : {}),
      nominatedAt: args.nominatedAt,
      expiresAt,
      status: "pending",
      attempts: 0,
    })
  }
  const nominations = [...byId.values()]
    .filter((item) => Date.parse(item.expiresAt) >= Date.parse(args.nominatedAt) || item.status === "classified")
    .sort((a, b) => Date.parse(b.nominatedAt) - Date.parse(a.nominatedAt))
  const pending = nominations.filter((item) => item.status === "pending" || item.status === "classifying")
  const keptPending = pending.slice(0, args.maxPending)
  const keptIds = new Set([
    ...keptPending.map((item) => item.nominationId),
    ...nominations.filter((item) => item.status !== "pending" && item.status !== "classifying").map((item) => item.nominationId),
  ])
  return {
    schema: 1,
    nominations: nominations.filter((item) => keptIds.has(item.nominationId)),
  }
}

export function nextPendingNomination(
  file: XSourceNominationsFile,
  nowIso: string,
): XSourceNomination | undefined {
  return file.nominations.find((item) => (
    item.status === "pending"
    && Date.parse(item.expiresAt) >= Date.parse(nowIso)
    && (!item.reviewAfter || Date.parse(item.reviewAfter) <= Date.parse(nowIso))
  ))
}

export function markClassifying(
  file: XSourceNominationsFile,
  nominationId: string,
): XSourceNominationsFile {
  return {
    schema: 1,
    nominations: file.nominations.map((item) => (
      item.nominationId === nominationId
        ? { ...item, status: "classifying" as const, attempts: item.attempts + 1 }
        : item
    )),
  }
}

export function classifiedNarrativeXHandles(
  file: XSourceNominationsFile,
): readonly string[] {
  const seen = new Set<string>()
  const handles: string[] = []
  for (const item of file.nominations) {
    if (item.status !== "classified") continue
    if (item.classification !== "narrative" && item.classification !== "both") continue
    const handle = normalizeXHandle(item.xHandle)
    if (!handle || seen.has(handle)) continue
    seen.add(handle)
    handles.push(handle)
  }
  return handles
}

export function applyClassificationResult(
  file: XSourceNominationsFile,
  args: Readonly<{
    nominationId: string
    status: XSourceNominationStatus
    classification?: XSourceNomination["classification"]
    classificationRunId?: string
    reviewAfter?: string
  }>,
): XSourceNominationsFile {
  return {
    schema: 1,
    nominations: file.nominations.map((item) => {
      if (item.nominationId !== args.nominationId) return item
      return {
        ...item,
        status: args.status,
        ...(args.classification ? { classification: args.classification } : {}),
        ...(args.classificationRunId ? { classificationRunId: args.classificationRunId } : {}),
        ...(args.reviewAfter ? { reviewAfter: args.reviewAfter } : {}),
      }
    }),
  }
}
