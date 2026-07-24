import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { type ArchiveLayout } from "../lib/archive.js"
import {
  DecisionBundleSchema,
  OutcomeObservationSchema,
  type CanonicalIdentity,
  type DecisionBundle,
  type OutcomeObservation,
} from "../contracts/schemas.js"
import { writeOutcomeObservation, readOutcomeObservation } from "./scorecard.js"
import {
  materializeObservation,
  type BarProvider,
  type BenchmarkProvider,
} from "./observations.js"
import { DEFAULT_HORIZONS, DEFAULT_SETTLEMENT_HOURS } from "./settle-source-calls.js"

const HOUR_MS = 3_600_000

function listDecisionBundles(layout: ArchiveLayout): DecisionBundle[] {
  const dir = layout.decisions
  if (!existsSync(dir)) return []
  const out: DecisionBundle[] = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue
    try {
      const parsed = DecisionBundleSchema.safeParse(
        JSON.parse(readFileSync(join(dir, name), "utf8")),
      )
      if (parsed.success) out.push(parsed.data)
    } catch {
      // skip malformed
    }
  }
  return out
}

function isMature(eventTs: string, horizonHours: number, settlementHours: number, nowMs: number): boolean {
  return Date.parse(eventTs) + (horizonHours + settlementHours) * HOUR_MS <= nowMs
}

function nonPriced(
  bundle: DecisionBundle,
  horizonHours: number,
  status: "provider-pending" | "censored",
  reason: string,
  observedAt: string,
): OutcomeObservation {
  return OutcomeObservationSchema.parse({
    schema: 1,
    subjectType: "decision",
    subjectId: bundle.decisionId,
    horizonHours,
    observationSpecVersion: 1,
    status,
    eventTs: bundle.decisionTs,
    exclusionReason: reason,
    observedAt,
  })
}

export type DecisionSettleReport = Readonly<{
  scanned: number
  written: number
  complete: number
  pending: number
  censored: number
  skipped: number
  noIdentity: number
}>

/**
 * Price archived decision bundles at each horizon into outcomes/decision/<id>/<h>h.json.
 * Requires card.identity; missing identity → censored (not a fabricated loss).
 * Resumable: identical complete observations are skipped; conflicting bytes reject.
 */
export async function runSettleDecisions(args: Readonly<{
  layout: ArchiveLayout
  nowIso: string
  horizons?: readonly number[]
  settlementHours?: number
  loadBars?: BarProvider<CanonicalIdentity>
  benchmark?: BenchmarkProvider<CanonicalIdentity>
  feeBpsPerSide?: number
  hitThreshold?: number
}>): Promise<DecisionSettleReport> {
  const horizons = args.horizons ?? DEFAULT_HORIZONS
  const settlementHours = args.settlementHours ?? DEFAULT_SETTLEMENT_HOURS
  const nowMs = Date.parse(args.nowIso)
  const bundles = listDecisionBundles(args.layout)

  let written = 0
  let complete = 0
  let pending = 0
  let censored = 0
  let skipped = 0
  let noIdentity = 0

  for (const bundle of bundles) {
    const identity = bundle.card.identity
    for (const horizonHours of horizons) {
      const existing = readOutcomeObservation(
        args.layout,
        "decision",
        bundle.decisionId,
        horizonHours,
      )
      if (existing?.status === "complete" || existing?.status === "terminal-loss") {
        skipped += 1
        continue
      }

      if (!identity) {
        noIdentity += 1
        const obs = nonPriced(bundle, horizonHours, "censored", "missing-identity", args.nowIso)
        if (existing && JSON.stringify(existing) === JSON.stringify(obs)) {
          skipped += 1
          continue
        }
        if (existing && existing.status !== obs.status) {
          throw new Error(
            `conflicting decision outcome ${bundle.decisionId}@${horizonHours}h`,
          )
        }
        await writeOutcomeObservation(args.layout, obs)
        written += 1
        censored += 1
        continue
      }

      if (!isMature(bundle.decisionTs, horizonHours, settlementHours, nowMs)) {
        const obs = nonPriced(bundle, horizonHours, "provider-pending", "horizon-not-mature", args.nowIso)
        if (existing?.status === "provider-pending") {
          skipped += 1
          continue
        }
        await writeOutcomeObservation(args.layout, obs)
        written += 1
        pending += 1
        continue
      }

      if (!args.loadBars) {
        const obs = nonPriced(bundle, horizonHours, "provider-pending", "no-bar-provider", args.nowIso)
        if (existing?.status === "provider-pending") {
          skipped += 1
          continue
        }
        await writeOutcomeObservation(args.layout, obs)
        written += 1
        pending += 1
        continue
      }

      const bars = await args.loadBars(identity, horizonHours)
      if (!bars || bars.length === 0) {
        const obs = nonPriced(bundle, horizonHours, "provider-pending", "empty-bars", args.nowIso)
        if (existing?.status === "provider-pending") {
          skipped += 1
          continue
        }
        await writeOutcomeObservation(args.layout, obs)
        written += 1
        pending += 1
        continue
      }

      const benchmarkReturn = args.benchmark
        ? await args.benchmark(identity, horizonHours)
        : 0
      const obs = materializeObservation({
        subjectType: "decision",
        subjectId: bundle.decisionId,
        eventTs: bundle.decisionTs,
        horizonHours,
        bars,
        observedAt: args.nowIso,
        benchmarkReturn: benchmarkReturn ?? 0,
        ...(args.feeBpsPerSide !== undefined ? { feeBpsPerSide: args.feeBpsPerSide } : {}),
      })

      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(obs)) {
          skipped += 1
          continue
        }
        throw new Error(
          `conflicting decision outcome ${bundle.decisionId}@${horizonHours}h`,
        )
      }

      await writeOutcomeObservation(args.layout, obs)
      written += 1
      if (obs.status === "complete" || obs.status === "terminal-loss") complete += 1
      else if (obs.status === "provider-pending") pending += 1
      else if (obs.status === "censored") censored += 1
    }
  }

  return {
    scanned: bundles.length,
    written,
    complete,
    pending,
    censored,
    skipped,
    noIdentity,
  }
}

/** Fold a settled decision observation into scorecard decision-row fields */
export function decisionOutcomeToScorecardFields(
  verdict: string,
  confidence: number,
  outcome: OutcomeObservation | undefined,
  hitThreshold = 0.20,
): {
  verdict: string
  confidence: number
  hit?: boolean
  excess72h?: number
  dropVindicated?: boolean
  ignoreWasMiss?: boolean
} {
  const row: {
    verdict: string
    confidence: number
    hit?: boolean
    excess72h?: number
    dropVindicated?: boolean
    ignoreWasMiss?: boolean
  } = { verdict, confidence }

  if (!outcome) return row
  const resolved = outcome.status === "complete" || outcome.status === "terminal-loss"
  if (!resolved || outcome.excessReturn === undefined) return row

  const good = outcome.excessReturn >= hitThreshold
  if (verdict === "track") {
    row.hit = good
    row.excess72h = outcome.excessReturn
  } else if (verdict === "drop") {
    row.dropVindicated = !good
  } else if (verdict === "ignore") {
    row.ignoreWasMiss = good
  }
  return row
}
