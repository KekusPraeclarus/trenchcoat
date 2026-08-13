import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("pump-scan run wiring", () => {
  it("treats pump-scan like list-scan for research hints, enqueue, and engagement", () => {
    const src = readFileSync(join(process.cwd(), "src/orchestrator/run.ts"), "utf8")
    expect(src).toMatch(/job\.name === "list-scan" \|\| job\.name === "farcaster-scan" \|\| job\.name === "pump-scan"/u)
    expect(src).toMatch(/job\.name === "pump-scan" && !opts\.dryCollect && !skipAgent/u)
    expect(src).toMatch(/processPumpScanEngagement/u)
    expect(src).toMatch(/validateAndEnqueueResearchCandidates/u)
    expect(src).toMatch(/pump-engagement-host\.json/u)
  })
})
