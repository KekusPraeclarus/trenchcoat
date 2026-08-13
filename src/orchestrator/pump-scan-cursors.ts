import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { z } from "zod"
import { writeAtomicFileFsync } from "../lib/fs-atomic.js"
import { PumpFeedTabSchema } from "../contracts/schemas.js"

const PumpScanCursorFileSchema = z.object({
  schema: z.literal(1),
  tabs: z.record(z.object({
    lastItemId: z.string().min(1).max(128),
    updatedAt: z.string().datetime(),
  })).default({}),
})

export type PumpScanCursorFile = z.infer<typeof PumpScanCursorFileSchema>

export function pumpScanHome(home = join(homedir(), ".trenchcoat")): string {
  return join(home, "pump-scan")
}

export function pumpScanCursorsPath(home = join(homedir(), ".trenchcoat")): string {
  return join(pumpScanHome(home), "cursors.json")
}

export function loadPumpScanCursors(path: string): PumpScanCursorFile {
  if (!existsSync(path)) return { schema: 1, tabs: {} }
  try {
    return PumpScanCursorFileSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return { schema: 1, tabs: {} }
  }
}

export async function savePumpScanCursors(
  path: string,
  file: PumpScanCursorFile,
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  await writeAtomicFileFsync(path, `${JSON.stringify(file, null, 2)}\n`)
}

export async function advancePumpScanCursor(args: Readonly<{
  cursorsPath: string
  tab: string
  lastItemId: string
  nowIso: string
}>): Promise<PumpScanCursorFile> {
  const parsedTab = PumpFeedTabSchema.safeParse(args.tab)
  const tab = parsedTab.success ? parsedTab.data : args.tab
  const cursors = loadPumpScanCursors(args.cursorsPath)
  cursors.tabs[tab] = {
    lastItemId: args.lastItemId,
    updatedAt: args.nowIso,
  }
  await savePumpScanCursors(args.cursorsPath, cursors)
  return cursors
}
