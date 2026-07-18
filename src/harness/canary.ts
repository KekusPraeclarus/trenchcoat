import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import {
  HarnessCanaryStateSchema,
  type HarnessCanaryState,
} from "../contracts/schemas.js"

export type CanaryAssignment = Readonly<{
  policyVersion: string
  assignment: "baseline" | "candidate" | "shadow"
  blockExternalEffects: boolean
  hypothesisId?: string
}>

export function harnessRoot(archiveRoot: string): string {
  return join(archiveRoot, "..", "harness-improvements")
}

export function canaryStatePath(archiveRoot: string): string {
  return join(harnessRoot(archiveRoot), "active-canary.json")
}

export function loadCanaryState(archiveRoot: string): HarnessCanaryState | undefined {
  const path = canaryStatePath(archiveRoot)
  if (!existsSync(path)) return undefined
  return HarnessCanaryStateSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

/** Deterministic 10% (or configured bps) assignment by episode id hash */
export function assignEpisode(
  episodeId: string,
  allocationBps: number,
  active: HarnessCanaryState | undefined,
): "baseline" | "candidate" {
  if (!active?.active || allocationBps <= 0) return "baseline"
  const digest = createHash("sha256").update(episodeId).digest()
  const bucket = digest.readUInt32BE(0) % 10_000
  return bucket < allocationBps ? "candidate" : "baseline"
}

/**
 * Production runs: candidate episodes get candidate policy + blocked egress.
 * Shadow baseline is recorded separately by the canary evaluator.
 */
export function loadActiveCanaryAssignment(
  archiveRoot: string,
  episodeId: string,
): CanaryAssignment {
  const active = loadCanaryState(archiveRoot)
  if (!active?.active) {
    return {
      policyVersion: "baseline",
      assignment: "baseline",
      blockExternalEffects: false,
    }
  }
  const assignment = assignEpisode(episodeId, active.allocationBps, active)
  if (assignment === "candidate") {
    return {
      policyVersion: active.policyVersion,
      assignment: "candidate",
      blockExternalEffects: true,
      hypothesisId: active.hypothesisId,
    }
  }
  return {
    policyVersion: "baseline",
    assignment: "baseline",
    blockExternalEffects: false,
  }
}
