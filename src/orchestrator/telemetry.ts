import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { TelemetryRunSchema, type TelemetryRun } from "../contracts/schemas.js"

export async function appendTelemetry(path: string, record: TelemetryRun): Promise<void> {
  const parsed = TelemetryRunSchema.parse(record)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await appendFile(path, `${JSON.stringify(parsed)}\n`, { encoding: "utf8", mode: 0o600 })
}
