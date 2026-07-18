import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import {
  HarnessCanaryStateSchema,
  HarnessEvaluationSchema,
  type HarnessCanaryState,
} from "../contracts/schemas.js"
import { canaryStatePath, harnessRoot, loadCanaryState } from "./canary.js"
import { loadHypothesis, saveHypothesis, hypothesisDir, listHypothesisIds } from "./propose.js"
import { systemClock } from "../lib/clock.js"

export async function startCanary(opts: Readonly<{
  archiveRoot: string
  hypothesisId: string
  allocationBps: number
  policyVersion: string
  nowIso?: string
}>): Promise<HarnessCanaryState> {
  const existing = loadCanaryState(opts.archiveRoot)
  if (existing?.active) {
    throw new Error(`Active canary already running: ${existing.hypothesisId}`)
  }
  const hypothesis = loadHypothesis(opts.archiveRoot, opts.hypothesisId)
  if (hypothesis.status !== "evaluated") {
    throw new Error("Canary requires evaluated hypothesis")
  }
  const evaluationPath = join(hypothesisDir(opts.archiveRoot, opts.hypothesisId), "evaluation.json")
  const evaluation = HarnessEvaluationSchema.parse(
    JSON.parse(readFileSync(evaluationPath, "utf8")),
  )
  if (!evaluation.primaryImproved || !evaluation.safetyFloorsPassed || !evaluation.testsPassed) {
    throw new Error("Evaluation gates failed — refusing canary")
  }

  const state = HarnessCanaryStateSchema.parse({
    schema: 1,
    hypothesisId: opts.hypothesisId,
    policyVersion: opts.policyVersion,
    allocationBps: opts.allocationBps,
    startedAt: opts.nowIso ?? systemClock.nowIso(),
    assignedEpisodes: 0,
    maturePaired: 0,
    active: true,
  })

  mkdirSync(harnessRoot(opts.archiveRoot), { recursive: true, mode: 0o700 })
  await writeAtomicFile(
    canaryStatePath(opts.archiveRoot),
    `${JSON.stringify(state, null, 2)}\n`,
  )
  await saveHypothesis(opts.archiveRoot, { ...hypothesis, status: "canary" })
  return state
}

export async function stopCanary(opts: Readonly<{
  archiveRoot: string
  reason: string
  nowIso?: string
  rollbackHypothesis?: boolean
}>): Promise<HarnessCanaryState> {
  const current = loadCanaryState(opts.archiveRoot)
  if (!current) throw new Error("No canary state")
  const stopped = HarnessCanaryStateSchema.parse({
    ...current,
    active: false,
    stoppedAt: opts.nowIso ?? systemClock.nowIso(),
    stopReason: opts.reason,
  })
  await writeAtomicFile(
    canaryStatePath(opts.archiveRoot),
    `${JSON.stringify(stopped, null, 2)}\n`,
  )
  if (opts.rollbackHypothesis !== false) {
    const hypothesis = loadHypothesis(opts.archiveRoot, current.hypothesisId)
    await saveHypothesis(opts.archiveRoot, { ...hypothesis, status: "rolled_back" })
  }
  return stopped
}

export type CanaryStopCheck = Readonly<{
  shouldStop: boolean
  reason?: string
}>

export function shouldStopCanary(args: Readonly<{
  rugExposure: number
  rugFloor: number
  candidateErrors: number
  errorBudget: number
  missingness: number
  missingnessMax: number
  sequentialRegressions: number
  integrityFailure: boolean
}>): CanaryStopCheck {
  if (args.integrityFailure) {
    return { shouldStop: true, reason: "integrity failure" }
  }
  if (args.rugExposure > args.rugFloor) {
    return { shouldStop: true, reason: "rug exposure safety floor" }
  }
  if (args.candidateErrors > args.errorBudget) {
    return { shouldStop: true, reason: "candidate error budget exhausted" }
  }
  if (args.missingness > args.missingnessMax) {
    return { shouldStop: true, reason: "excessive outcome missingness" }
  }
  if (args.sequentialRegressions >= 3) {
    return { shouldStop: true, reason: "sequential paired regression" }
  }
  return { shouldStop: false }
}

export async function promoteHypothesis(opts: Readonly<{
  archiveRoot: string
  hypothesisId: string
  nowIso?: string
}>): Promise<void> {
  const state = loadCanaryState(opts.archiveRoot)
  if (state?.active && state.hypothesisId === opts.hypothesisId) {
    await stopCanary({
      archiveRoot: opts.archiveRoot,
      reason: "promoted to baseline",
      ...(opts.nowIso ? { nowIso: opts.nowIso } : {}),
      rollbackHypothesis: false,
    })
  }
  const hypothesis = loadHypothesis(opts.archiveRoot, opts.hypothesisId)
  await saveHypothesis(opts.archiveRoot, { ...hypothesis, status: "promoted" })
  const dir = hypothesisDir(opts.archiveRoot, opts.hypothesisId)
  await writeAtomicFile(
    join(dir, "promotion.json"),
    `${JSON.stringify({
      hypothesisId: opts.hypothesisId,
      promotedAt: opts.nowIso ?? systemClock.nowIso(),
      note: "Human-gated promotion recorded; merge/scaffold remains operator-owned",
    }, null, 2)}\n`,
  )
}

export function canaryStatus(archiveRoot: string): {
  active?: HarnessCanaryState
  hypotheses: string[]
} {
  const active = loadCanaryState(archiveRoot)
  return {
    ...(active ? { active } : {}),
    hypotheses: listHypothesisIds(archiveRoot),
  }
}

export function harnessJournalPath(archiveRoot: string, hypothesisId: string): string {
  return join(hypothesisDir(archiveRoot, hypothesisId), "journal.json")
}

export const HARNESS_PHASES = [
  "created",
  "proposed",
  "prepared",
  "evaluated",
  "canary",
  "complete",
] as const

export type HarnessPhase = typeof HARNESS_PHASES[number]

export type HarnessJournal = Readonly<{
  schema: 1
  hypothesisId: string
  phase: HarnessPhase
  phaseHashes: Readonly<Partial<Record<HarnessPhase, `sha256:${string}`>>>
}>

export async function advanceHarnessJournal(
  archiveRoot: string,
  hypothesisId: string,
  phase: HarnessPhase,
  payloadHash: `sha256:${string}`,
): Promise<HarnessJournal> {
  const path = harnessJournalPath(archiveRoot, hypothesisId)
  const current: HarnessJournal = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8")) as HarnessJournal
    : { schema: 1, hypothesisId, phase: "created", phaseHashes: {} }

  const currentIndex = HARNESS_PHASES.indexOf(current.phase)
  const nextIndex = HARNESS_PHASES.indexOf(phase)
  if (nextIndex === currentIndex && current.phaseHashes[phase] === payloadHash) {
    return current
  }
  if (nextIndex !== currentIndex + 1) {
    throw new Error(`Harness phase must advance from ${current.phase} to ${phase}`)
  }
  const next: HarnessJournal = {
    schema: 1,
    hypothesisId,
    phase,
    phaseHashes: { ...current.phaseHashes, [phase]: payloadHash },
  }
  await writeAtomicFile(path, `${JSON.stringify(next, null, 2)}\n`)
  return next
}
