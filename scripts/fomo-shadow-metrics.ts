/**
 * Append a daily Fomo shadow metrics receipt (resumable).
 * Reads skip ledgers + optional inbox snapshot counts; never prints secrets.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { appendFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

const day = argValue("--day") ?? new Date().toISOString().slice(0, 10)
const archiveRoot = join(homedir(), ".trenchcoat", "archive")
const outDir = join(archiveRoot, "provider-evaluations", "fomo", "shadow-metrics")
mkdirSync(outDir, { recursive: true, mode: 0o700 })
const outPath = join(outDir, `${day}.jsonl`)

function countSkipReasons(job: string): Record<string, number> {
  const path = join(archiveRoot, "skips", `${job}.jsonl`)
  if (!existsSync(path)) return {}
  const counts: Record<string, number> = {}
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as { reason?: string, skippedAt?: string }
      if (!row.skippedAt?.startsWith(day)) continue
      const reason = row.reason ?? "unknown"
      counts[reason] = (counts[reason] ?? 0) + 1
    } catch {
      // skip malformed
    }
  }
  return counts
}

function usageSummary(): Readonly<{ reserved?: number, budget?: number }> {
  const path = join(archiveRoot, "provider-usage", "fomo", `${day}.json`)
  if (!existsSync(path)) return {}
  try {
    const row = JSON.parse(readFileSync(path, "utf8")) as {
      reserved?: number
      budget?: number
    }
    return {
      ...(row.reserved !== undefined ? { reserved: row.reserved } : {}),
      ...(row.budget !== undefined ? { budget: row.budget } : {}),
    }
  } catch {
    return {}
  }
}

const receipt = {
  schema: 1,
  day,
  recordedAt: new Date().toISOString(),
  traderSyncSkips: countSkipReasons("fomo-trader-sync"),
  signalScanSkips: countSkipReasons("fomo-signal-scan"),
  xSourceReviewSkips: countSkipReasons("fomo-x-source-review"),
  usage: usageSummary(),
}

await appendFile(outPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ wrote: outPath, receipt }, null, 2))
