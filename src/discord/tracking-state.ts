import type {
  DiscordTrackingFile,
  TrackingDeliveryRecord,
  TrackingMatchBatch,
  TrackingRequestRecord,
} from "./schemas.js"
import {
  addDaysIso,
  addHoursIso,
  isExpiredAt,
  isWithinHours,
  mentionTextHash,
  newTrackingId,
  normalizeTrackingSubject,
  trackingDeliveryId,
  trackingDeliveryIdFromIdentity,
} from "./tracking-ids.js"
import {
  renderCapacityMessage,
  sanitizeTrackingReason,
} from "./tracking-sanitize.js"

/** Fail closed when the request names a chain and the resolved identity differs */
export function trackingChainAllows(
  requestChain: TrackingRequestRecord["chain"] | undefined,
  resolvedChain: string,
): boolean {
  if (!requestChain) return true
  return requestChain === resolvedChain
}

export type TrackingConfigSlice = Readonly<{
  max_active_per_user: number
  ttl_days: number
  expiry_bundle_hours: number
  pending_capacity_ttl_hours: number
  tentative_confirm_window_hours: number
  expiry_reply_window_days: number
  retention_days: number
}>

/**
 * Cap terminal match batches after retention. Pending/running always stay.
 * Stops tracking.json from growing past the store soft size under heavy scan volume.
 */
export const MAX_TERMINAL_MATCH_BATCHES = 400

export function countActiveForUser(
  file: DiscordTrackingFile,
  guildId: string,
  userId: string,
  nowIso: string,
): number {
  return file.requests.filter((r) => (
    r.guildId === guildId
    && r.userId === userId
    && r.status === "active"
    && !isExpiredAt(r.expiresAt, nowIso)
  )).length
}

export function activeMatchableRequests(
  file: DiscordTrackingFile,
  nowIso: string,
): TrackingRequestRecord[] {
  return file.requests.filter((r) => (
    r.status === "active"
    && !isExpiredAt(r.expiresAt, nowIso)
  ))
}

export function userRequests(
  file: DiscordTrackingFile,
  guildId: string,
  userId: string,
): TrackingRequestRecord[] {
  return file.requests.filter((r) => r.guildId === guildId && r.userId === userId)
}

export type TrackActionResult =
  | {
    ok: true
    file: DiscordTrackingFile
    request: TrackingRequestRecord
    kind: "active" | "tentative" | "pending-capacity" | "duplicate"
    reactMessageIds: string[]
    reply?: string
  }
  | { ok: false; reason: string }

export function applyTrackAction(args: Readonly<{
  file: DiscordTrackingFile
  guildId: string
  channelId: string
  messageId: string
  userId: string
  description: string
  shortLabel: string
  confidence: "high" | "low"
  nowIso: string
  config: TrackingConfigSlice
  chain?: TrackingRequestRecord["chain"]
  duplicateOfId?: string
  confirmTentativeId?: string
}>): TrackActionResult {
  if (!Number.isFinite(Date.parse(args.nowIso))) {
    return { ok: false, reason: "invalid-now" }
  }

  let file = { ...args.file, requests: [...args.file.requests] }

  if (args.duplicateOfId) {
    const existing = file.requests.find((r) => (
      r.trackingId === args.duplicateOfId
      && r.guildId === args.guildId
      && r.userId === args.userId
      && r.status === "active"
      && !isExpiredAt(r.expiresAt, args.nowIso)
    ))
    if (!existing) return { ok: false, reason: "duplicate-not-found" }
    return {
      ok: true,
      file,
      request: existing,
      kind: "duplicate",
      reactMessageIds: [args.messageId],
    }
  }

  if (args.confirmTentativeId) {
    const idx = file.requests.findIndex((r) => (
      r.trackingId === args.confirmTentativeId
      && r.guildId === args.guildId
      && r.userId === args.userId
      && r.status === "tentative"
    ))
    if (idx < 0) return { ok: false, reason: "tentative-not-found" }
    const current = file.requests[idx]!
    const windowMs = args.config.tentative_confirm_window_hours * 3_600_000
    if (Date.parse(args.nowIso) - Date.parse(current.createdAt) > windowMs) {
      return { ok: false, reason: "tentative-expired" }
    }
    const activeCount = countActiveForUser(file, args.guildId, args.userId, args.nowIso)
    if (activeCount >= args.config.max_active_per_user) {
      const pending: TrackingRequestRecord = {
        ...current,
        status: "pending-capacity",
        updatedAt: args.nowIso,
        pendingExpiresAt: addHoursIso(args.nowIso, args.config.pending_capacity_ttl_hours),
        messageId: args.messageId,
        channelId: args.channelId,
      }
      file.requests[idx] = pending
      return {
        ok: true,
        file,
        request: pending,
        kind: "pending-capacity",
        reactMessageIds: [],
        reply: capacityReply(file, args.guildId, args.userId, args.nowIso, args.config),
      }
    }
    const activated: TrackingRequestRecord = {
      ...current,
      status: "active",
      updatedAt: args.nowIso,
      expiresAt: addDaysIso(args.nowIso, args.config.ttl_days),
      messageId: args.messageId,
      channelId: args.channelId,
      pendingExpiresAt: undefined,
    }
    file.requests[idx] = activated
    return {
      ok: true,
      file,
      request: activated,
      kind: "active",
      reactMessageIds: [args.messageId],
    }
  }

  const description = args.description.trim().slice(0, 500)
  const shortLabel = args.shortLabel.trim().slice(0, 64)
  if (!description || !shortLabel) return { ok: false, reason: "empty-description" }

  const chainFields = args.chain ? { chain: args.chain } : {}

  if (args.confidence === "low") {
    const tentative: TrackingRequestRecord = {
      trackingId: newTrackingId(Date.parse(args.nowIso)),
      guildId: args.guildId,
      channelId: args.channelId,
      messageId: args.messageId,
      userId: args.userId,
      description,
      shortLabel,
      ...chainFields,
      status: "tentative",
      createdAt: args.nowIso,
      updatedAt: args.nowIso,
      expiresAt: addDaysIso(args.nowIso, args.config.ttl_days),
      extensionCount: 0,
      matchedSubjects: [],
      pendingExpiresAt: addHoursIso(args.nowIso, args.config.tentative_confirm_window_hours),
    }
    file.requests.push(tentative)
    return {
      ok: true,
      file,
      request: tentative,
      kind: "tentative",
      reactMessageIds: [],
    }
  }

  const activeCount = countActiveForUser(file, args.guildId, args.userId, args.nowIso)
  if (activeCount >= args.config.max_active_per_user) {
    const pending: TrackingRequestRecord = {
      trackingId: newTrackingId(Date.parse(args.nowIso)),
      guildId: args.guildId,
      channelId: args.channelId,
      messageId: args.messageId,
      userId: args.userId,
      description,
      shortLabel,
      ...chainFields,
      status: "pending-capacity",
      createdAt: args.nowIso,
      updatedAt: args.nowIso,
      expiresAt: addDaysIso(args.nowIso, args.config.ttl_days),
      extensionCount: 0,
      matchedSubjects: [],
      pendingExpiresAt: addHoursIso(args.nowIso, args.config.pending_capacity_ttl_hours),
    }
    file.requests.push(pending)
    return {
      ok: true,
      file,
      request: pending,
      kind: "pending-capacity",
      reactMessageIds: [],
      reply: capacityReply(file, args.guildId, args.userId, args.nowIso, args.config),
    }
  }

  const active: TrackingRequestRecord = {
    trackingId: newTrackingId(Date.parse(args.nowIso)),
    guildId: args.guildId,
    channelId: args.channelId,
    messageId: args.messageId,
    userId: args.userId,
    description,
    shortLabel,
    ...chainFields,
    status: "active",
    createdAt: args.nowIso,
    updatedAt: args.nowIso,
    expiresAt: addDaysIso(args.nowIso, args.config.ttl_days),
    extensionCount: 0,
    matchedSubjects: [],
  }
  file.requests.push(active)
  return {
    ok: true,
    file,
    request: active,
    kind: "active",
    reactMessageIds: [args.messageId],
  }
}

function capacityReply(
  file: DiscordTrackingFile,
  guildId: string,
  userId: string,
  nowIso: string,
  config: TrackingConfigSlice,
): string {
  const labels = file.requests
    .filter((r) => (
      r.guildId === guildId
      && r.userId === userId
      && r.status === "active"
      && !isExpiredAt(r.expiresAt, nowIso)
    ))
    .map((r) => r.shortLabel)
  return renderCapacityMessage(labels, config.max_active_per_user)
}

export type DropActionResult =
  | {
    ok: true
    file: DiscordTrackingFile
    droppedIds: string[]
    activated?: TrackingRequestRecord
    reactMessageIds: string[]
  }
  | { ok: false; reason: string }

export function applyDropAction(args: Readonly<{
  file: DiscordTrackingFile
  guildId: string
  userId: string
  trackingIds: readonly string[]
  triggerMessageId: string
  nowIso: string
  config: TrackingConfigSlice
}>): DropActionResult {
  if (args.trackingIds.length === 0) return { ok: false, reason: "empty-ids" }
  const idSet = new Set(args.trackingIds)
  const file: DiscordTrackingFile = {
    ...args.file,
    requests: args.file.requests.map((r) => ({ ...r })),
  }

  const droppedIds: string[] = []
  for (let i = 0; i < file.requests.length; i += 1) {
    const r = file.requests[i]!
    if (!idSet.has(r.trackingId)) continue
    if (r.guildId !== args.guildId || r.userId !== args.userId) {
      return { ok: false, reason: "cross-owner" }
    }
    if (r.status !== "active" && r.status !== "pending-capacity" && r.status !== "tentative") {
      return { ok: false, reason: "invalid-status" }
    }
    file.requests[i] = {
      ...r,
      status: "dropped",
      updatedAt: args.nowIso,
    }
    droppedIds.push(r.trackingId)
  }
  if (droppedIds.length === 0) return { ok: false, reason: "none-dropped" }

  const reactMessageIds = [args.triggerMessageId]
  let activated: TrackingRequestRecord | undefined
  const room = countActiveForUser(file, args.guildId, args.userId, args.nowIso)
  if (room < args.config.max_active_per_user) {
    const pending = file.requests
      .filter((r) => (
        r.guildId === args.guildId
        && r.userId === args.userId
        && r.status === "pending-capacity"
        && (!r.pendingExpiresAt || !isExpiredAt(r.pendingExpiresAt, args.nowIso))
      ))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    if (pending) {
      const idx = file.requests.findIndex((r) => r.trackingId === pending.trackingId)
      const next: TrackingRequestRecord = {
        ...pending,
        status: "active",
        updatedAt: args.nowIso,
        expiresAt: addDaysIso(args.nowIso, args.config.ttl_days),
        pendingExpiresAt: undefined,
      }
      file.requests[idx] = next
      activated = next
      reactMessageIds.push(pending.messageId)
    }
  }

  return { ok: true, file, droppedIds, ...(activated ? { activated } : {}), reactMessageIds }
}

export type ExtendActionResult =
  | {
    ok: true
    file: DiscordTrackingFile
    extendedIds: string[]
    declinedIds: string[]
    reactMessageIds: string[]
  }
  | { ok: false; reason: string; reply?: string }

export function applyExtendAction(args: Readonly<{
  file: DiscordTrackingFile
  guildId: string
  userId: string
  extendIds: readonly string[]
  declineIds: readonly string[]
  triggerMessageId: string
  nowIso: string
  config: TrackingConfigSlice
}>): ExtendActionResult {
  const file: DiscordTrackingFile = {
    ...args.file,
    requests: args.file.requests.map((r) => ({ ...r })),
  }
  const extendSet = new Set(args.extendIds)
  const declineSet = new Set(args.declineIds)

  const wouldActivate = file.requests.filter((r) => (
    extendSet.has(r.trackingId)
    && r.guildId === args.guildId
    && r.userId === args.userId
    && (r.status === "expired-awaiting-reply" || r.status === "active")
  ))
  for (const r of wouldActivate) {
    if (r.guildId !== args.guildId || r.userId !== args.userId) {
      return { ok: false, reason: "cross-owner" }
    }
  }

  const activeNow = countActiveForUser(file, args.guildId, args.userId, args.nowIso)
  const newlyActive = wouldActivate.filter((r) => r.status === "expired-awaiting-reply").length
  if (activeNow + newlyActive > args.config.max_active_per_user) {
    return {
      ok: false,
      reason: "cap",
      reply: capacityReply(file, args.guildId, args.userId, args.nowIso, args.config),
    }
  }

  const extendedIds: string[] = []
  const declinedIds: string[] = []

  for (let i = 0; i < file.requests.length; i += 1) {
    const r = file.requests[i]!
    if (r.guildId !== args.guildId || r.userId !== args.userId) {
      if (extendSet.has(r.trackingId) || declineSet.has(r.trackingId)) {
        return { ok: false, reason: "cross-owner" }
      }
      continue
    }
    if (extendSet.has(r.trackingId)) {
      if (r.status !== "expired-awaiting-reply" && r.status !== "active") {
        return { ok: false, reason: "invalid-extend-status" }
      }
      const elapsed = isExpiredAt(r.expiresAt, args.nowIso)
      const nextExpires = elapsed
        ? addDaysIso(args.nowIso, args.config.ttl_days)
        : addDaysIso(r.expiresAt, args.config.ttl_days)
      file.requests[i] = {
        ...r,
        status: "active",
        updatedAt: args.nowIso,
        expiresAt: nextExpires,
        extensionCount: r.extensionCount + 1,
        expiryNoticeMessageId: undefined,
      }
      extendedIds.push(r.trackingId)
    } else if (declineSet.has(r.trackingId)) {
      const elapsed = isExpiredAt(r.expiresAt, args.nowIso) || r.status === "expired-awaiting-reply"
      file.requests[i] = {
        ...r,
        status: elapsed ? "expired-final" : "dropped",
        updatedAt: args.nowIso,
        expiryNoticeMessageId: undefined,
      }
      declinedIds.push(r.trackingId)
    }
  }

  if (extendedIds.length === 0 && declinedIds.length === 0) {
    return { ok: false, reason: "none-changed" }
  }
  return {
    ok: true,
    file,
    extendedIds,
    declinedIds,
    reactMessageIds: [args.triggerMessageId],
  }
}

export type ExpirySweepPlan = Readonly<{
  userKey: string
  guildId: string
  channelId: string
  userId: string
  elapsedIds: string[]
  bundledIds: string[]
  labels: string[]
}>

export function planExpiryNotices(args: Readonly<{
  file: DiscordTrackingFile
  nowIso: string
  config: TrackingConfigSlice
}>): ExpirySweepPlan[] {
  const byUser = new Map<string, TrackingRequestRecord[]>()
  for (const r of args.file.requests) {
    if (r.status !== "active") continue
    if (r.expiryNoticeMessageId) continue
    const elapsed = isExpiredAt(r.expiresAt, args.nowIso)
    const soon = isWithinHours(r.expiresAt, args.nowIso, args.config.expiry_bundle_hours)
    if (!elapsed && !soon) continue
    if (!elapsed) continue
    const key = `${r.guildId}:${r.userId}`
    const list = byUser.get(key) ?? []
    list.push(r)
    byUser.set(key, list)
  }

  const plans: ExpirySweepPlan[] = []
  for (const [userKey, elapsed] of byUser) {
    const sample = elapsed[0]!
    const bundled = args.file.requests.filter((r) => (
      r.guildId === sample.guildId
      && r.userId === sample.userId
      && r.status === "active"
      && !r.expiryNoticeMessageId
      && (
        isExpiredAt(r.expiresAt, args.nowIso)
        || isWithinHours(r.expiresAt, args.nowIso, args.config.expiry_bundle_hours)
      )
    ))
    const elapsedIds = bundled.filter((r) => isExpiredAt(r.expiresAt, args.nowIso)).map((r) => r.trackingId)
    const bundledIds = bundled.map((r) => r.trackingId)
    plans.push({
      userKey,
      guildId: sample.guildId,
      channelId: sample.channelId,
      userId: sample.userId,
      elapsedIds,
      bundledIds,
      labels: bundled.map((r) => r.shortLabel),
    })
  }
  return plans
}

export function applyExpiryNoticeSent(args: Readonly<{
  file: DiscordTrackingFile
  plan: ExpirySweepPlan
  noticeMessageId: string
  nowIso: string
}>): DiscordTrackingFile {
  const idSet = new Set(args.plan.bundledIds)
  const elapsedSet = new Set(args.plan.elapsedIds)
  return {
    ...args.file,
    requests: args.file.requests.map((r) => {
      if (!idSet.has(r.trackingId)) return r
      const next: TrackingRequestRecord = {
        ...r,
        updatedAt: args.nowIso,
        expiryNoticeMessageId: args.noticeMessageId,
      }
      if (elapsedSet.has(r.trackingId)) {
        next.status = "expired-awaiting-reply"
      }
      return next
    }),
  }
}

/** Flip active→expired-awaiting-reply at exact expiry even if already notice-bound */
export function flipElapsedAwaitingReply(args: Readonly<{
  file: DiscordTrackingFile
  nowIso: string
}>): DiscordTrackingFile {
  let changed = false
  const requests = args.file.requests.map((r) => {
    if (r.status !== "active") return r
    if (!isExpiredAt(r.expiresAt, args.nowIso)) return r
    changed = true
    return { ...r, status: "expired-awaiting-reply" as const, updatedAt: args.nowIso }
  })
  return changed ? { ...args.file, requests } : args.file
}

export function pruneTrackingFile(args: Readonly<{
  file: DiscordTrackingFile
  nowIso: string
  config: TrackingConfigSlice
}>): DiscordTrackingFile {
  const now = Date.parse(args.nowIso)
  const replyWindowMs = args.config.expiry_reply_window_days * 86_400_000
  const retentionMs = args.config.retention_days * 86_400_000
  const pendingTtlMs = args.config.pending_capacity_ttl_hours * 3_600_000
  const tentativeMs = args.config.tentative_confirm_window_hours * 3_600_000

  let requests = args.file.requests.map((r) => {
    if (r.status === "expired-awaiting-reply") {
      const base = r.updatedAt
      if (now - Date.parse(base) > replyWindowMs) {
        return { ...r, status: "expired-final" as const, updatedAt: args.nowIso }
      }
    }
    if (r.status === "pending-capacity") {
      const deadline = r.pendingExpiresAt ?? addHoursIso(r.createdAt, args.config.pending_capacity_ttl_hours)
      if (isExpiredAt(deadline, args.nowIso)) {
        return { ...r, status: "dropped" as const, updatedAt: args.nowIso }
      }
    }
    if (r.status === "tentative") {
      if (now - Date.parse(r.createdAt) > tentativeMs) {
        return { ...r, status: "dropped" as const, updatedAt: args.nowIso }
      }
    }
    return r
  })

  const liveRequestIds = new Set(
    requests
      .filter((r) => (
        r.status === "active"
        || r.status === "pending-capacity"
        || r.status === "tentative"
        || r.status === "expired-awaiting-reply"
      ))
      .map((r) => r.trackingId),
  )

  requests = requests.filter((r) => {
    if (
      r.status === "active"
      || r.status === "pending-capacity"
      || r.status === "tentative"
      || r.status === "expired-awaiting-reply"
    ) return true
    return now - Date.parse(r.updatedAt) <= retentionMs
  })

  const retainedBatches = args.file.matchBatches.filter((b) => (
    now - Date.parse(b.updatedAt) <= retentionMs
    || b.status === "pending"
    || b.status === "running"
  ))
  const liveBatches = retainedBatches.filter((b) => (
    b.status === "pending" || b.status === "running"
  ))
  const terminalBatches = retainedBatches
    .filter((b) => b.status === "completed" || b.status === "failed")
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, MAX_TERMINAL_MATCH_BATCHES)
  const matchBatches = [...liveBatches, ...terminalBatches]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))

  const trackingDeliveries = args.file.trackingDeliveries.filter((d) => {
    if (liveRequestIds.has(d.trackingId)) return true
    return now - Date.parse(d.updatedAt) <= retentionMs
  })

  return { ...args.file, requests, matchBatches, trackingDeliveries }
}

export function upsertMatchBatch(
  file: DiscordTrackingFile,
  batch: TrackingMatchBatch,
): DiscordTrackingFile {
  const existing = file.matchBatches.find((b) => b.batchId === batch.batchId)
  if (existing) return file
  return {
    ...file,
    matchBatches: [...file.matchBatches, batch],
  }
}

export function createOrGetDelivery(args: Readonly<{
  file: DiscordTrackingFile
  trackingId: string
  subject: string
  reason: string
  batchId: string
  sourceKind: TrackingMatchBatch["sourceKind"]
  nowIso: string
  request: TrackingRequestRecord
  needsResearch: boolean
  researchSummary?: string
  tokenQuery?: string
  candidateProvenance?: string
  chain?: string
  tokenAddress?: string
  shortLabel?: string
  qualificationSource?: TrackingDeliveryRecord["qualificationSource"]
  status?: TrackingDeliveryRecord["status"]
}>): { file: DiscordTrackingFile; delivery: TrackingDeliveryRecord; created: boolean } {
  const chain = args.chain
  const tokenAddress = args.tokenAddress?.trim().toLowerCase()
  const deliveryId = chain && tokenAddress
    ? trackingDeliveryIdFromIdentity(args.trackingId, chain, tokenAddress)
    : trackingDeliveryId(args.trackingId, normalizeTrackingSubject(args.subject))
  const normalizedSubject = chain && tokenAddress
    ? `${chain}:${tokenAddress}`
    : normalizeTrackingSubject(args.subject)

  const existing = args.file.trackingDeliveries.find((d) => d.deliveryId === deliveryId)
  if (existing) {
    return { file: args.file, delivery: existing, created: false }
  }

  // Only suppress when an alert was already delivered for this canonical token
  if (args.request.matchedSubjects.includes(normalizedSubject)) {
    const synthetic: TrackingDeliveryRecord = {
      deliveryId,
      trackingId: args.trackingId,
      subject: args.subject.slice(0, 256),
      normalizedSubject,
      reason: sanitizeTrackingReason(args.reason),
      status: "delivered",
      guildId: args.request.guildId,
      channelId: args.request.channelId,
      userId: args.request.userId,
      anchorMessageId: args.request.messageId,
      parts: [],
      deliveredPartKeys: [],
      discordMessageIds: [],
      attemptCount: 0,
      createdAt: args.nowIso,
      updatedAt: args.nowIso,
      batchId: args.batchId,
      sourceKind: args.sourceKind,
      needsResearch: false,
      researchEnqueued: false,
      mentionItems: [],
      ...(chain ? { chain: chain as TrackingDeliveryRecord["chain"] } : {}),
      ...(tokenAddress ? { tokenAddress } : {}),
      ...(args.shortLabel ? { shortLabel: args.shortLabel.slice(0, 64) } : {}),
    }
    return { file: args.file, delivery: synthetic, created: false }
  }

  const reason = sanitizeTrackingReason(args.reason)
  const status = args.status
    ?? (args.needsResearch ? "research-pending" : "qualified-pending")
  const delivery: TrackingDeliveryRecord = {
    deliveryId,
    trackingId: args.trackingId,
    subject: args.subject.slice(0, 256),
    normalizedSubject,
    reason: reason.length > 0 ? reason : "a matching project",
    status,
    guildId: args.request.guildId,
    channelId: args.request.channelId,
    userId: args.request.userId,
    anchorMessageId: args.request.messageId,
    parts: [],
    deliveredPartKeys: [],
    discordMessageIds: [],
    attemptCount: 0,
    createdAt: args.nowIso,
    updatedAt: args.nowIso,
    batchId: args.batchId,
    sourceKind: args.sourceKind,
    needsResearch: args.needsResearch,
    researchEnqueued: false,
    mentionItems: [],
    ...(args.researchSummary ? { researchSummary: args.researchSummary.slice(0, 8_000) } : {}),
    ...(args.tokenQuery ? { tokenQuery: args.tokenQuery.slice(0, 256) } : {}),
    ...(args.candidateProvenance
      ? { candidateProvenance: args.candidateProvenance.slice(0, 256) }
      : {}),
    ...(chain ? { chain: chain as TrackingDeliveryRecord["chain"] } : {}),
    ...(tokenAddress ? { tokenAddress } : {}),
    ...(args.shortLabel
      ? { shortLabel: args.shortLabel.slice(0, 64) }
      : { shortLabel: args.request.shortLabel.slice(0, 64) }),
    ...(args.qualificationSource ? { qualificationSource: args.qualificationSource } : {}),
  }

  // matchedSubjects is updated only after a successful delivered alert
  return {
    file: {
      ...args.file,
      trackingDeliveries: [...args.file.trackingDeliveries, delivery],
    },
    delivery,
    created: true,
  }
}

export function markDeliveryMatchedSubject(args: Readonly<{
  file: DiscordTrackingFile
  trackingId: string
  normalizedSubject: string
  nowIso: string
}>): DiscordTrackingFile {
  return {
    ...args.file,
    requests: args.file.requests.map((r) => {
      if (r.trackingId !== args.trackingId) return r
      if (r.matchedSubjects.includes(args.normalizedSubject)) return r
      return {
        ...r,
        matchedSubjects: [...r.matchedSubjects, args.normalizedSubject].slice(0, 500),
        updatedAt: args.nowIso,
      }
    }),
  }
}

export function appendUniqueMention(args: Readonly<{
  delivery: TrackingDeliveryRecord
  provenance: string
  text: string
  nowIso: string
}>): { delivery: TrackingDeliveryRecord; added: boolean } {
  const provenance = args.provenance.slice(0, 256)
  const text = args.text.slice(0, 2_000)
  const textHash = mentionTextHash(text)
  if (
    args.delivery.mentionItems.some((m) => (
      m.provenance === provenance || m.textHash === textHash
    ))
  ) {
    return { delivery: args.delivery, added: false }
  }
  const mentionItems = [
    ...args.delivery.mentionItems,
    { provenance, textHash, text, seenAt: args.nowIso },
  ].slice(0, 20)
  return {
    delivery: {
      ...args.delivery,
      mentionItems,
      updatedAt: args.nowIso,
    },
    added: true,
  }
}

export function isDeliveryBlacklisted(
  delivery: TrackingDeliveryRecord,
  nowIso: string,
): boolean {
  if (!delivery.blacklistedUntil) return false
  return Date.parse(delivery.blacklistedUntil) > Date.parse(nowIso)
}

export function requestsForExpiryNotice(
  file: DiscordTrackingFile,
  noticeMessageId: string,
  guildId: string,
  userId: string,
): TrackingRequestRecord[] {
  return file.requests.filter((r) => (
    r.expiryNoticeMessageId === noticeMessageId
    && r.guildId === guildId
    && r.userId === userId
  ))
}
