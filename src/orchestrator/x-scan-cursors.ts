import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { z } from "zod"
import { writeAtomicFileFsync } from "../lib/fs-atomic.js"

const XScanCursorFileSchema = z.object({
  schema: z.literal(1),
  targets: z.record(z.object({
    lastPostId: z.string().min(1).max(64),
    updatedAt: z.string().datetime(),
  })).default({}),
  lastRoundCompletedAt: z.string().datetime().optional(),
})

export type XScanCursorFile = z.infer<typeof XScanCursorFileSchema>

export function xScanHome(home = join(homedir(), ".trenchcoat")): string {
  return join(home, "x-scan")
}

export function xScanCursorsPath(home = join(homedir(), ".trenchcoat")): string {
  return join(xScanHome(home), "cursors.json")
}

export function loadXScanCursors(path: string): XScanCursorFile {
  if (!existsSync(path)) return { schema: 1, targets: {} }
  try {
    return XScanCursorFileSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return { schema: 1, targets: {} }
  }
}

export async function saveXScanCursors(
  path: string,
  file: XScanCursorFile,
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  await writeAtomicFileFsync(path, `${JSON.stringify(file, null, 2)}\n`)
}

export async function advanceXScanCursor(args: Readonly<{
  cursorsPath: string
  targetLabel: string
  lastPostId: string
  nowIso: string
}>): Promise<XScanCursorFile> {
  const cursors = loadXScanCursors(args.cursorsPath)
  cursors.targets[args.targetLabel] = {
    lastPostId: args.lastPostId,
    updatedAt: args.nowIso,
  }
  await saveXScanCursors(args.cursorsPath, cursors)
  return cursors
}

export async function markXScanRoundComplete(args: Readonly<{
  cursorsPath: string
  nowIso: string
}>): Promise<XScanCursorFile> {
  const cursors = loadXScanCursors(args.cursorsPath)
  const next: XScanCursorFile = {
    ...cursors,
    lastRoundCompletedAt: args.nowIso,
  }
  await saveXScanCursors(args.cursorsPath, next)
  return next
}

/** Uniform delay in [minMs, maxMs] inclusive */
export function randomRoundDelayMs(
  minMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const lo = Math.min(minMs, maxMs)
  const hi = Math.max(minMs, maxMs)
  const span = hi - lo + 1
  return lo + Math.floor(random() * span)
}

export const X_SCAN_ROUND_DELAY_MIN_MS = 5 * 60 * 1_000
export const X_SCAN_ROUND_DELAY_MAX_MS = 30 * 60 * 1_000
