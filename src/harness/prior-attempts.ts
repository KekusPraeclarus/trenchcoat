import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { sha256Json } from "../lib/canonical-json.js"
import { WorkspaceLock } from "../lib/lock.js"
import {
  HarnessHypothesisSchema,
  HarnessPlanSchema,
  HarnessRejectionReceiptSchema,
  PriorAttemptRecordSchema,
  isHarnessPlanV2,
  type PriorAttemptRecord,
} from "../contracts/schemas.js"
import { hypothesisDir, listHypothesisIds } from "./propose.js"

export function priorAttemptsPath(archiveRoot: string): string {
  return join(archiveRoot, "..", "harness-improvements", "prior-attempts.jsonl")
}

function priorAttemptsLockPath(archiveRoot: string): string {
  return join(archiveRoot, "..", "harness-improvements", ".prior-attempts.lock")
}

function reasonCodeFrom(reason: string | undefined): string | undefined {
  if (!reason) return undefined
  const lower = reason.toLowerCase()
  if (lower.includes("confinement")) return "confinement"
  if (lower.includes("primary-not-improved") || lower.includes("holdout")) {
    return "holdout-fail"
  }
  if (lower.includes("protected")) return "protected-regression"
  if (lower.includes("safety")) return "safety-floor"
  if (lower.includes("tests")) return "tests"
  if (lower.includes("review")) return "review-reject"
  if (lower.includes("duplicate")) return "duplicate"
  return "other"
}

function resultClassFor(
  status: PriorAttemptRecord["status"],
  phase: string,
): PriorAttemptRecord["resultClass"] {
  if (status === "rolled_back") return "rollback"
  if (phase.includes("holdout") || phase === "rejected") return "holdout-fail"
  if (phase.includes("review") || phase.includes("plan")) return "review-reject"
  if (phase.includes("canary")) return "canary-stop"
  return "other"
}

function recordFromHypothesisDir(
  archiveRoot: string,
  hypothesisId: string,
): PriorAttemptRecord | undefined {
  const dir = hypothesisDir(archiveRoot, hypothesisId)
  const hypPath = join(dir, "hypothesis.json")
  if (!existsSync(hypPath)) return undefined
  let hypothesis
  try {
    hypothesis = HarnessHypothesisSchema.parse(
      JSON.parse(readFileSync(hypPath, "utf8")),
    )
  } catch {
    return undefined
  }
  if (
    hypothesis.status !== "rejected"
    && hypothesis.status !== "rolled_back"
  ) {
    return undefined
  }

  let phase: string = hypothesis.status
  let reason: string | undefined
  let planFingerprint: `sha256:${string}` | undefined
  const rejectionPath = join(dir, "rejection.json")
  if (existsSync(rejectionPath)) {
    try {
      const receipt = HarnessRejectionReceiptSchema.parse(
        JSON.parse(readFileSync(rejectionPath, "utf8")),
      )
      phase = receipt.phase
      reason = receipt.reason
    } catch {
      // ignore malformed
    }
  }
  const planPath = join(dir, "plan.json")
  if (existsSync(planPath)) {
    try {
      const plan = HarnessPlanSchema.parse(
        JSON.parse(readFileSync(planPath, "utf8")),
      )
      planFingerprint = sha256Json({
        primaryMetric: plan.primaryMetric,
        proposedPolicyChanges: plan.proposedPolicyChanges,
        ...(isHarnessPlanV2(plan)
          ? {
            evidenceIds: plan.evidenceIds,
            predictedFixes: plan.predictedFixes,
          }
          : {}),
      } as never)
    } catch {
      // ignore
    }
  }

  let policyDiffFingerprint: `sha256:${string}` | undefined
  const evalPath = join(dir, "evaluation.json")
  if (existsSync(evalPath)) {
    try {
      const raw = JSON.parse(readFileSync(evalPath, "utf8")) as {
        candidateCommit?: string
      }
      if (raw.candidateCommit) {
        policyDiffFingerprint = sha256Json({
          candidateCommit: raw.candidateCommit,
        } as never)
      }
    } catch {
      // ignore
    }
  }

  const status: PriorAttemptRecord["status"] =
    hypothesis.status === "rolled_back" ? "rolled_back" : "rejected"
  return PriorAttemptRecordSchema.parse({
    schema: 1,
    hypothesisId,
    status,
    phase,
    primaryMetric: hypothesis.primaryMetric,
    ...(hypothesis.weaknessPatternId
      ? { weaknessPatternId: hypothesis.weaknessPatternId }
      : {}),
    ...(planFingerprint ? { planFingerprint } : {}),
    ...(policyDiffFingerprint ? { policyDiffFingerprint } : {}),
    resultClass: resultClassFor(status, phase),
    ...(reasonCodeFrom(reason) ? { reasonCode: reasonCodeFrom(reason) } : {}),
    recordedAt: hypothesis.createdAt,
  })
}

/** Lock + scan hypothesis dirs + atomic write. Preferred over append. */
export async function rebuildPriorAttemptsIndex(
  archiveRoot: string,
): Promise<readonly PriorAttemptRecord[]> {
  const root = join(archiveRoot, "..", "harness-improvements")
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const lock = new WorkspaceLock(priorAttemptsLockPath(archiveRoot))
  if (!lock.tryAcquire()) {
    throw new Error("prior-attempts index lock held")
  }
  try {
    const ids = listHypothesisIds(archiveRoot)
    const records: PriorAttemptRecord[] = []
    for (const id of ids) {
      const record = recordFromHypothesisDir(archiveRoot, id)
      if (record) records.push(record)
    }
    records.sort((a, b) => {
      const byTime = a.recordedAt.localeCompare(b.recordedAt)
      if (byTime !== 0) return byTime
      return a.hypothesisId.localeCompare(b.hypothesisId)
    })
    const lines = records.map((r) => JSON.stringify(r)).join("\n")
    await writeAtomicFile(
      priorAttemptsPath(archiveRoot),
      lines.length > 0 ? `${lines}\n` : "",
    )
    return records
  } finally {
    lock.release()
  }
}

export async function appendPriorAttempt(
  archiveRoot: string,
  record: PriorAttemptRecord,
): Promise<void> {
  PriorAttemptRecordSchema.parse(record)
  await rebuildPriorAttemptsIndex(archiveRoot)
}

export type PriorAttemptsSummary = Readonly<{
  schema: 1
  builtAt: string
  count: number
  records: readonly PriorAttemptRecord[]
}>

export function buildPriorAttemptsSummary(
  archiveRoot: string,
  opts: Readonly<{
    nowIso: string
    maxRecords?: number
    primaryMetric?: string
    weaknessPatternId?: string
  }>,
): PriorAttemptsSummary {
  const path = priorAttemptsPath(archiveRoot)
  let records: PriorAttemptRecord[] = []
  if (existsSync(path)) {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean)
    for (const line of lines) {
      try {
        records.push(PriorAttemptRecordSchema.parse(JSON.parse(line)))
      } catch {
        // skip malformed lines
      }
    }
  }
  if (opts.primaryMetric) {
    records = records.filter((r) => r.primaryMetric === opts.primaryMetric)
  }
  if (opts.weaknessPatternId) {
    records = records.filter(
      (r) => r.weaknessPatternId === opts.weaknessPatternId,
    )
  }
  records.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
  const max = opts.maxRecords ?? 32
  const capped = records.slice(0, max)
  return {
    schema: 1,
    builtAt: opts.nowIso,
    count: capped.length,
    records: capped,
  }
}

export function isExactDuplicate(
  candidate: Readonly<{
    planFingerprint?: `sha256:${string}`
    policyDiffFingerprint?: `sha256:${string}`
  }>,
  prior: readonly PriorAttemptRecord[],
): PriorAttemptRecord | undefined {
  if (candidate.planFingerprint) {
    const hit = prior.find((p) => p.planFingerprint === candidate.planFingerprint)
    if (hit) return hit
  }
  if (candidate.policyDiffFingerprint) {
    return prior.find(
      (p) => p.policyDiffFingerprint === candidate.policyDiffFingerprint,
    )
  }
  return undefined
}

export function isNearDuplicateSamePatternLever(
  candidate: Readonly<{
    weaknessPatternId?: string
    primaryMetric: string
  }>,
  prior: readonly PriorAttemptRecord[],
): PriorAttemptRecord | undefined {
  if (!candidate.weaknessPatternId) return undefined
  return prior.find(
    (p) =>
      p.weaknessPatternId === candidate.weaknessPatternId
      && p.primaryMetric === candidate.primaryMetric,
  )
}

export function ensurePriorAttemptsIndex(
  archiveRoot: string,
): Promise<readonly PriorAttemptRecord[]> {
  const path = priorAttemptsPath(archiveRoot)
  if (!existsSync(path)) return rebuildPriorAttemptsIndex(archiveRoot)
  // Lazy rebuild if hypothesis dirs exist but index empty
  const ids = listHypothesisIds(archiveRoot)
  if (ids.length === 0) return Promise.resolve([])
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean)
  if (lines.length === 0 && ids.length > 0) {
    return rebuildPriorAttemptsIndex(archiveRoot)
  }
  return Promise.resolve(
    lines.flatMap((line) => {
      try {
        return [PriorAttemptRecordSchema.parse(JSON.parse(line))]
      } catch {
        return []
      }
    }),
  )
}

/** List dirs under harness-improvements for debugging */
export function listPriorAttemptSourceDirs(archiveRoot: string): string[] {
  const root = join(archiveRoot, "..", "harness-improvements")
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "meta" && d.name !== "_deploy")
    .map((d) => d.name)
    .sort()
}
