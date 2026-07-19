import { describe, expect, it } from "vitest"
import { provenanceToSource } from "../../src/orchestrator/rug-dock.js"
import { sourceIdForHandle } from "../../src/sources/lifecycle.js"

describe("call-log source id alignment", () => {
  it("maps twitter:@handle provenance to x_<handle> like lifecycle candidates", () => {
    const mapped = provenanceToSource("twitter:@AlphaTrader")
    expect(mapped?.sourceId).toBe("x_alphatrader")
    expect(mapped?.sourceId).toBe(sourceIdForHandle("AlphaTrader"))
  })

  it("keeps farcaster provenance on fc_ ids", () => {
    const mapped = provenanceToSource("farcaster:12345")
    expect(mapped?.sourceId).toMatch(/^fc_/u)
  })
})
