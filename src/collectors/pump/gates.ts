import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "../../lib/fs-atomic.js"
import { PumpGatesFileSchema, type PumpGatesFile, type PumpGateVerdict } from "./types.js"

const STALE_MS = 30 * 24 * 60 * 60 * 1_000

export function gatesPath(archiveRoot: string): string {
  return join(archiveRoot, "provider-evaluations", "pump", "gates.json")
}

export async function savePumpGates(
  archiveRoot: string,
  gates: PumpGatesFile,
): Promise<void> {
  const parsed = PumpGatesFileSchema.parse(gates)
  await writeAtomicFile(gatesPath(archiveRoot), `${JSON.stringify(parsed, null, 2)}\n`)
}

export function loadPumpGates(archiveRoot: string): PumpGatesFile | undefined {
  const path = gatesPath(archiveRoot)
  if (!existsSync(path)) return undefined
  try {
    return PumpGatesFileSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return undefined
  }
}

export function gateIsFresh(gates: PumpGatesFile, nowMs = Date.now()): boolean {
  const evaluated = Date.parse(gates.evaluatedAt)
  if (!Number.isFinite(evaluated)) return false
  return nowMs - evaluated <= STALE_MS
}

export function requireGatePass(
  archiveRoot: string,
  gate: keyof PumpGatesFile["gates"],
  nowMs = Date.now(),
): Readonly<{ ok: true } | { ok: false, reason: string }> {
  const gates = loadPumpGates(archiveRoot)
  if (!gates) return { ok: false, reason: "pump-gates-missing" }
  if (!gateIsFresh(gates, nowMs)) return { ok: false, reason: "pump-gates-stale" }
  const verdict: PumpGateVerdict = gates.gates[gate].verdict
  if (verdict !== "pass") return { ok: false, reason: `pump-gate-${gate}-${verdict}` }
  return { ok: true }
}

export function providerGateAllowsSchedule(archiveRoot: string, nowMs = Date.now()): boolean {
  return requireGatePass(archiveRoot, "provider", nowMs).ok
}
