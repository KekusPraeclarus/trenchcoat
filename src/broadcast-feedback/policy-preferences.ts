import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  OperatorPreferenceSetSchema,
  type FeedbackPolicyExample,
  type OperatorPreferenceSet,
  type SealedFeedbackDataset,
} from "../contracts/schemas.js"
import { ACTIVE_PREFERENCE_SET_FILE } from "../harness/operator-preference.js"
import type { BroadcastFeedbackLayout } from "./paths.js"

/**
 * Project a sealed dataset into the numeric preference set that standard
 * harness evaluation reads. Only signal vectors survive the projection, so no
 * text ever crosses into the harness (INV-S24).
 */

export function buildOperatorPreferenceSet(args: Readonly<{
  dataset: SealedFeedbackDataset
  signalsByEvent: ReadonlyMap<string, Readonly<Record<string, number>>>
}>): OperatorPreferenceSet {
  const pairs = args.dataset.preferencePairs.flatMap((pair) => {
    const preferredSignals = args.signalsByEvent.get(pair.preferredEventId)
    const rejectedSignals = args.signalsByEvent.get(pair.rejectedEventId)
    if (!preferredSignals || !rejectedSignals) return []
    return [{
      pairId: pair.pairId,
      claimType: pair.claimType,
      severity: pair.severity,
      preferredSignals,
      rejectedSignals,
    }]
  })
  return OperatorPreferenceSetSchema.parse({
    schema: 1,
    datasetId: args.dataset.datasetId,
    sealedAt: args.dataset.sealedAt,
    pairs,
  })
}

/** Signals from the sealed policy examples, keyed by event id */
export function signalsFromExamples(
  examples: readonly FeedbackPolicyExample[],
): ReadonlyMap<string, Readonly<Record<string, number>>> {
  return new Map(examples.map((example) => [example.eventId, example.signals]))
}

export function writeActivePreferenceSet(args: Readonly<{
  layout: BroadcastFeedbackLayout
  set: OperatorPreferenceSet
}>): string {
  mkdirSync(args.layout.sealed, { recursive: true, mode: 0o700 })
  const path = join(args.layout.sealed, ACTIVE_PREFERENCE_SET_FILE)
  writeFileSync(path, `${JSON.stringify(args.set, null, 2)}\n`, { mode: 0o600 })
  return path
}
