import { sha256Json, type JsonValue } from "../lib/canonical-json.js"

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/

export type AuditSubjectType =
  | "broadcast"
  | "decision"
  | "discovery"
  | "resolution"
  | "source-call"

export type AuditSubject = Readonly<{
  id: string
  type: AuditSubjectType
  eventTimestamp: number
  horizonHours: number
}>

export type AuditEpochInput = Readonly<{
  epochId: string
  previousEpochId: string | null
  startedAt: number
  cutoffTimestamp: number
  settlementDelayHours: number
  priorSourceScoreCutoff: number
  configHash: `sha256:${string}`
  featureSpecVersion: number
  executionModelVersion: number
  codeCommit: string
  subjects: readonly AuditSubject[]
}>

export type AuditEpochManifest = Readonly<{
  schema: 1
  epochId: string
  previousEpochId: string | null
  startedAt: number
  cutoffTimestamp: number
  settlementDelayHours: number
  priorSourceScoreCutoff: number
  configHash: `sha256:${string}`
  featureSpecVersion: number
  executionModelVersion: number
  codeCommit: string
  subjects: readonly AuditSubject[]
  manifestHash: `sha256:${string}`
}>

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`)
  }
}

function validateSubject(subject: AuditSubject): void {
  if (!SAFE_ID.test(subject.id)) {
    throw new TypeError("Audit subject id is invalid")
  }

  assertNonNegativeInteger(subject.eventTimestamp, "eventTimestamp")
  assertNonNegativeInteger(subject.horizonHours, "horizonHours")

  if (subject.horizonHours === 0) {
    throw new TypeError("horizonHours must be positive")
  }
}

export function isAuditSubjectEligible(
  subject: AuditSubject,
  cutoffTimestamp: number,
  settlementDelayHours: number,
): boolean {
  validateSubject(subject)
  assertNonNegativeInteger(cutoffTimestamp, "cutoffTimestamp")
  assertNonNegativeInteger(settlementDelayHours, "settlementDelayHours")

  const maturityTimestamp = subject.eventTimestamp
    + (subject.horizonHours + settlementDelayHours) * 3_600

  if (!Number.isSafeInteger(maturityTimestamp)) {
    throw new RangeError("Audit subject maturity exceeds safe integer range")
  }

  return maturityTimestamp <= cutoffTimestamp
}

function manifestJson(
  input: Omit<AuditEpochManifest, "manifestHash">,
): JsonValue {
  return {
    schema: input.schema,
    epochId: input.epochId,
    previousEpochId: input.previousEpochId,
    startedAt: input.startedAt,
    cutoffTimestamp: input.cutoffTimestamp,
    settlementDelayHours: input.settlementDelayHours,
    priorSourceScoreCutoff: input.priorSourceScoreCutoff,
    configHash: input.configHash,
    featureSpecVersion: input.featureSpecVersion,
    executionModelVersion: input.executionModelVersion,
    codeCommit: input.codeCommit,
    subjects: input.subjects.map((subject) => ({
      id: subject.id,
      type: subject.type,
      eventTimestamp: subject.eventTimestamp,
      horizonHours: subject.horizonHours,
    })),
  }
}

export function freezeAuditEpoch(input: AuditEpochInput): AuditEpochManifest {
  if (!SAFE_ID.test(input.epochId)) {
    throw new TypeError("Audit epoch id is invalid")
  }

  if (input.previousEpochId !== null && !SAFE_ID.test(input.previousEpochId)) {
    throw new TypeError("Previous audit epoch id is invalid")
  }

  if (!SHA256.test(input.configHash)) {
    throw new TypeError("Audit config hash is invalid")
  }

  if (!/^[a-f0-9]{7,64}$/.test(input.codeCommit)) {
    throw new TypeError("Audit code commit is invalid")
  }

  assertNonNegativeInteger(input.startedAt, "startedAt")
  assertNonNegativeInteger(input.cutoffTimestamp, "cutoffTimestamp")
  assertNonNegativeInteger(input.settlementDelayHours, "settlementDelayHours")
  assertNonNegativeInteger(input.priorSourceScoreCutoff, "priorSourceScoreCutoff")
  assertNonNegativeInteger(input.featureSpecVersion, "featureSpecVersion")
  assertNonNegativeInteger(input.executionModelVersion, "executionModelVersion")

  if (input.startedAt < input.cutoffTimestamp) {
    throw new TypeError("Audit epoch cannot start before its cutoff")
  }

  const seen = new Set<string>()
  const subjects = [...input.subjects]
    .map((subject) => {
      validateSubject(subject)
      const key = `${subject.type}:${subject.id}:${subject.horizonHours}`
      if (seen.has(key)) {
        throw new TypeError(`Duplicate audit subject ${key}`)
      }
      seen.add(key)

      if (!isAuditSubjectEligible(
        subject,
        input.cutoffTimestamp,
        input.settlementDelayHours,
      )) {
        throw new TypeError(`Ineligible audit subject ${key}`)
      }

      return Object.freeze({ ...subject })
    })
    .sort((left, right) => (
      left.type.localeCompare(right.type)
      || left.id.localeCompare(right.id)
      || left.horizonHours - right.horizonHours
    ))

  const manifestWithoutHash = Object.freeze({
    schema: 1 as const,
    epochId: input.epochId,
    previousEpochId: input.previousEpochId,
    startedAt: input.startedAt,
    cutoffTimestamp: input.cutoffTimestamp,
    settlementDelayHours: input.settlementDelayHours,
    priorSourceScoreCutoff: input.priorSourceScoreCutoff,
    configHash: input.configHash,
    featureSpecVersion: input.featureSpecVersion,
    executionModelVersion: input.executionModelVersion,
    codeCommit: input.codeCommit,
    subjects: Object.freeze(subjects),
  })

  return Object.freeze({
    ...manifestWithoutHash,
    manifestHash: sha256Json(manifestJson(manifestWithoutHash)),
  })
}
