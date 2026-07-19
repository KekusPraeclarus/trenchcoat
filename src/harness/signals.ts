import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  DecisionBundleSchema,
  type DecisionBundle,
} from "../contracts/schemas.js"
import type { ArchiveLayout } from "../lib/archive.js"
import { loadSealedEpoch } from "../orchestrator/scorecard.js"
import type { ReplaySubject } from "./replay.js"

export class IneligibleEpochError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.name = "IneligibleEpochError"
    this.reason = reason
  }
}

function loadDecisionBundle(
  layout: ArchiveLayout,
  decisionId: string,
): DecisionBundle | undefined {
  const path = join(layout.decisions, `${decisionId}.json`)
  if (!existsSync(path)) return undefined
  try {
    return DecisionBundleSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return undefined
  }
}

function signalsPresent(signals: Readonly<Record<string, number>> | undefined): boolean {
  if (!signals) return false
  return Object.keys(signals).length > 0
}

export type HoldoutSignalsResult =
  | Readonly<{ ok: true, subjects: readonly ReplaySubject[] }>
  | Readonly<{ ok: false, reason: string }>

/**
 * Load holdout subjects with decision-time signals from archived bundles.
 * Fail closed: any subject missing a non-empty signals map makes the epoch ineligible.
 */
export function loadHoldoutSubjectsWithSignals(
  layout: ArchiveLayout,
  holdout: ReturnType<typeof loadSealedEpoch>,
): HoldoutSignalsResult {
  const subjects: ReplaySubject[] = []
  for (const subject of holdout.manifest.subjects) {
    const bundle = loadDecisionBundle(layout, subject.id)
    if (!bundle || !signalsPresent(bundle.signals)) {
      return {
        ok: false,
        reason: `subject ${subject.id} lacks decision-time signals`,
      }
    }
    subjects.push({
      subjectId: subject.id,
      subjectType: subject.type as ReplaySubject["subjectType"],
      horizonHours: subject.horizonHours,
      signals: bundle.signals,
    })
  }
  if (subjects.length === 0) {
    return { ok: false, reason: "holdout has no subjects" }
  }
  return { ok: true, subjects }
}

export function loadHoldoutSubjectsWithSignalsOrThrow(
  layout: ArchiveLayout,
  holdout: ReturnType<typeof loadSealedEpoch>,
): readonly ReplaySubject[] {
  const result = loadHoldoutSubjectsWithSignals(layout, holdout)
  if (!result.ok) throw new IneligibleEpochError(result.reason)
  return result.subjects
}

export function epochHasDecisionSignals(
  layout: ArchiveLayout,
  epochId: string,
): boolean {
  try {
    const sealed = loadSealedEpoch(layout, epochId)
    return loadHoldoutSubjectsWithSignals(layout, sealed).ok
  } catch {
    return false
  }
}
