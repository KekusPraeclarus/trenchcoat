import { z } from "zod"

export const NarrativeFramingSchema = z.enum(["rotation", "ecosystem", "regime"])
export type NarrativeFraming = z.infer<typeof NarrativeFramingSchema>

export function isMatureFraming(
  framing: NarrativeFraming | undefined,
): boolean {
  return framing === "ecosystem" || framing === "regime"
}

export function effectiveFraming(
  entry: Readonly<{ framing?: NarrativeFraming | undefined }>,
): NarrativeFraming {
  return entry.framing ?? "rotation"
}
