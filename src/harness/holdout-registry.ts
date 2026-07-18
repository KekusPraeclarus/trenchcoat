import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { archiveLayout } from "../lib/archive.js"
import {
  HoldoutConsumptionSchema,
  SafeIdSchema,
  type HoldoutConsumption,
} from "../contracts/schemas.js"

export function holdoutsDir(archiveRoot: string): string {
  return join(archiveLayout(archiveRoot).harness, "holdouts")
}

export function holdoutConsumptionPath(archiveRoot: string, epochId: string): string {
  // SafeId forbids "/" and any leading dot, so the id cannot escape the dir
  return join(holdoutsDir(archiveRoot), `${SafeIdSchema.parse(epochId)}.json`)
}

export function loadHoldoutConsumption(
  archiveRoot: string,
  epochId: string,
): HoldoutConsumption | undefined {
  const path = holdoutConsumptionPath(archiveRoot, epochId)
  if (!existsSync(path)) return undefined
  return HoldoutConsumptionSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export function isHoldoutConsumed(archiveRoot: string, epochId: string): boolean {
  return loadHoldoutConsumption(archiveRoot, epochId) !== undefined
}

/**
 * Persist single-use consumption of a holdout epoch. Refuses to overwrite an
 * existing record so a holdout can never be silently re-graded.
 */
export async function recordHoldoutConsumption(args: Readonly<{
  archiveRoot: string
  consumption: HoldoutConsumption
}>): Promise<HoldoutConsumption> {
  const parsed = HoldoutConsumptionSchema.parse(args.consumption)
  rejectReuse(args.archiveRoot, parsed.epochId)
  const path = holdoutConsumptionPath(args.archiveRoot, parsed.epochId)
  await writeAtomicFile(path, `${JSON.stringify(parsed, null, 2)}\n`)
  return parsed
}

export function rejectReuse(archiveRoot: string, epochId: string): void {
  if (isHoldoutConsumed(archiveRoot, epochId)) {
    throw new Error(`Holdout epoch ${epochId} already consumed`)
  }
}
