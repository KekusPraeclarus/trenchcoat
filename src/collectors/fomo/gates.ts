import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "../../lib/fs-atomic.js"
import { FomoGatesFileSchema, type FomoGatesFile, type FomoGateVerdict } from "./types.js"

const STALE_MS = 30 * 24 * 60 * 60 * 1_000

export function gatesPath(archiveRoot: string): string {
  return join(archiveRoot, "provider-evaluations", "fomo", "gates.json")
}

export async function saveFomoGates(
  archiveRoot: string,
  gates: FomoGatesFile,
): Promise<void> {
  const parsed = FomoGatesFileSchema.parse(gates)
  await writeAtomicFile(gatesPath(archiveRoot), `${JSON.stringify(parsed, null, 2)}\n`)
}

export function loadFomoGates(archiveRoot: string): FomoGatesFile | undefined {
  const path = gatesPath(archiveRoot)
  if (!existsSync(path)) return undefined
  try {
    return FomoGatesFileSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return undefined
  }
}

export function gateIsFresh(gates: FomoGatesFile, nowMs = Date.now()): boolean {
  const evaluated = Date.parse(gates.evaluatedAt)
  if (!Number.isFinite(evaluated)) return false
  return nowMs - evaluated <= STALE_MS
}

export function requireGatePass(
  archiveRoot: string,
  gate: keyof FomoGatesFile["gates"],
  nowMs = Date.now(),
): Readonly<{ ok: true } | { ok: false, reason: string }> {
  const gates = loadFomoGates(archiveRoot)
  if (!gates) return { ok: false, reason: "fomo-gates-missing" }
  if (!gateIsFresh(gates, nowMs)) return { ok: false, reason: "fomo-gates-stale" }
  const verdict: FomoGateVerdict = gates.gates[gate].verdict
  if (verdict !== "pass") return { ok: false, reason: `fomo-gate-${gate}-${verdict}` }
  return { ok: true }
}

export function providerGateAllowsSchedule(archiveRoot: string, nowMs = Date.now()): boolean {
  return requireGatePass(archiveRoot, "provider", nowMs).ok
}
