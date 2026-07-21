import { createHash, randomBytes } from "node:crypto"
import type { TrackingMatchSourceKind } from "./schemas.js"

export function newTrackingId(nowMs = Date.now()): string {
  const stamp = nowMs.toString(36)
  const entropy = randomBytes(6).toString("hex")
  return `trk-${stamp}-${entropy}`
}

export function normalizeTrackingSubject(subject: string): string {
  return subject.trim().toLowerCase().replace(/\s+/gu, " ").slice(0, 256)
}

export function matchBatchId(args: Readonly<{
  sourceKind: TrackingMatchSourceKind
  runId: string
  snapshotHash: string
}>): string {
  return createHash("sha256")
    .update(`${args.sourceKind}|${args.runId}|${args.snapshotHash}`)
    .digest("hex")
    .slice(0, 32)
}

export function trackingDeliveryId(trackingId: string, normalizedSubject: string): string {
  return createHash("sha256")
    .update(`${trackingId}|${normalizedSubject}`)
    .digest("hex")
    .slice(0, 32)
}

export function addDaysIso(iso: string, days: number): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) throw new Error("invalid timestamp")
  return new Date(ms + days * 86_400_000).toISOString()
}

export function addHoursIso(iso: string, hours: number): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) throw new Error("invalid timestamp")
  return new Date(ms + hours * 3_600_000).toISOString()
}

export function isExpiredAt(expiresAt: string, nowIso: string): boolean {
  return Date.parse(expiresAt) <= Date.parse(nowIso)
}

export function isWithinHours(
  expiresAt: string,
  nowIso: string,
  hours: number,
): boolean {
  const now = Date.parse(nowIso)
  const exp = Date.parse(expiresAt)
  if (!Number.isFinite(now) || !Number.isFinite(exp)) return false
  return exp > now && exp < now + hours * 3_600_000
}
