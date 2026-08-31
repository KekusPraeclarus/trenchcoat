import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { z } from "zod"
import { writeAtomicFileFsync } from "../../lib/fs-atomic.js"

export const X_SESSION_HOLD_FILENAME = "session-hold.json"

export const XSessionHoldSchema = z.object({
  schema: z.literal(1),
  reason: z.literal("challenge"),
  heldAt: z.string().datetime(),
  target: z.string().min(1).max(80).optional(),
  clearWith: z.literal("tc auth twitter").default("tc auth twitter"),
})

export type XSessionHold = z.infer<typeof XSessionHoldSchema>

export class XSessionHeldError extends Error {
  readonly code = "x-session-held"
  readonly hold: XSessionHold

  constructor(hold: XSessionHold) {
    const target = hold.target ? ` (${hold.target})` : ""
    super(
      `X session held after challenge since ${hold.heldAt}${target}`
        + " — run `tc auth twitter`",
    )
    this.name = "XSessionHeldError"
    this.hold = hold
  }
}

export function xSessionHoldPath(home = join(homedir(), ".trenchcoat")): string {
  return join(home, "x-scan", X_SESSION_HOLD_FILENAME)
}

export function loadXSessionHold(path: string): XSessionHold | undefined {
  if (!existsSync(path)) return undefined
  try {
    return XSessionHoldSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return undefined
  }
}

export async function saveXSessionHold(args: Readonly<{
  path: string
  heldAt: string
  target?: string
}>): Promise<XSessionHold> {
  const hold = XSessionHoldSchema.parse({
    schema: 1,
    reason: "challenge",
    heldAt: args.heldAt,
    clearWith: "tc auth twitter",
    ...(args.target ? { target: args.target.slice(0, 80) } : {}),
  })
  await writeAtomicFileFsync(args.path, `${JSON.stringify(hold, null, 2)}\n`)
  return hold
}

export function clearXSessionHold(path: string): boolean {
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}

export function assertXSessionNotHeld(home?: string): void {
  const hold = loadXSessionHold(xSessionHoldPath(home))
  if (hold) throw new XSessionHeldError(hold)
}
