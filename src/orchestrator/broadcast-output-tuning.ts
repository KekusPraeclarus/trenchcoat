import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  BroadcastOutputTuningSchema,
  type BroadcastOutputTuning,
} from "../contracts/schemas.js"

/**
 * Approved output guidance from operator feedback (ADR 043). The file lives in
 * the repo and only `broadcast feedback apply` writes it. Prompts read the
 * bounded lines; raw operator prose never reaches a prompt.
 */

export const BROADCAST_OUTPUT_TUNING_PATH = "config/broadcast-output-tuning.json"

export const EMPTY_BROADCAST_OUTPUT_TUNING: BroadcastOutputTuning = Object.freeze({
  schema: 1,
  updatedAt: "1970-01-01T00:00:00.000Z",
  copyGuidance: [],
  worthinessGuidance: [],
})

/**
 * Repo root for tuning reads. Scheduled jobs often start with cwd `/`, so the
 * host env value comes first. This never throws — a miss reads as no guidance.
 */
export function resolveTuningRepoRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env["TRENCHCOAT_REPO_ROOT"]?.trim() || process.cwd()
}

/** Fail open with empty guidance: a broken file must not stop broadcasts */
export function loadBroadcastOutputTuning(
  repoRoot: string,
): BroadcastOutputTuning {
  const path = join(repoRoot, BROADCAST_OUTPUT_TUNING_PATH)
  if (!existsSync(path)) return EMPTY_BROADCAST_OUTPUT_TUNING
  try {
    return BroadcastOutputTuningSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return EMPTY_BROADCAST_OUTPUT_TUNING
  }
}

function guidanceBlock(title: string, lines: readonly string[]): string {
  if (lines.length === 0) return ""
  return [title, ...lines.map((line) => `- ${line}`)].join("\n")
}

export function copyGuidanceBlock(tuning: BroadcastOutputTuning): string {
  return guidanceBlock(
    "Operator-approved copy guidance:",
    tuning.copyGuidance,
  )
}

export function worthinessGuidanceBlock(tuning: BroadcastOutputTuning): string {
  return guidanceBlock(
    "Operator-approved worthiness guidance:",
    tuning.worthinessGuidance,
  )
}

/** Append a guidance block to a fixed host prompt, keeping order stable */
export function withGuidance(base: string, block: string): string {
  return block.length === 0 ? base : `${base}\n\n${block}`
}
