/**
 * Integrity hold: while a market-affecting remediation awaits recovery/revalidation,
 * affected jobs must not stage new market broadcasts or commit production state.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { writeAtomicFileFsync } from "../lib/fs-atomic.js"
import { remediationHome } from "./paths.js"

export const IntegrityHoldSchema = z.object({
  schema: z.literal(1),
  incidentId: z.string().min(8).max(128),
  affectedSources: z.array(z.string().max(64)).max(32),
  affectedJobs: z.array(z.string().max(64)).max(32),
  heldAt: z.string().min(1).max(64),
  reason: z.string().max(500),
})
export type IntegrityHold = z.infer<typeof IntegrityHoldSchema>

export function integrityHoldPath(home?: string): string {
  return join(remediationHome(home), "integrity-hold.json")
}

export function loadIntegrityHold(home?: string): IntegrityHold | undefined {
  const path = integrityHoldPath(home)
  if (!existsSync(path)) return undefined
  try {
    return IntegrityHoldSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return undefined
  }
}

export async function setIntegrityHold(hold: IntegrityHold, home?: string): Promise<void> {
  IntegrityHoldSchema.parse(hold)
  await writeAtomicFileFsync(
    integrityHoldPath(home),
    `${JSON.stringify(hold, null, 2)}\n`,
    0o600,
  )
}

export async function clearIntegrityHold(home?: string): Promise<void> {
  const path = integrityHoldPath(home)
  if (!existsSync(path)) return
  await writeAtomicFileFsync(path, "", 0o600)
  const { unlinkSync } = await import("node:fs")
  try {
    unlinkSync(path)
  } catch {
    // empty file is also fine as cleared
  }
}

export function jobHeldByIntegrity(
  hold: IntegrityHold | undefined,
  job: string,
): boolean {
  if (!hold) return false
  return hold.affectedJobs.includes(job)
    || hold.affectedJobs.includes("*")
}
