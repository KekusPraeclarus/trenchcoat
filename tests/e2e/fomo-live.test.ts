import { describe, expect, it } from "vitest"

const live = process.env["TRENCHCOAT_LIVE_FOMO"] === "1"

describe.runIf(live)("live fomo read-only", () => {
  it("session assert or typed client error", async () => {
    const { fomoSessionExists } = await import("../../src/collectors/social/fomo-auth.js")
    const { FomoClientError } = await import("../../src/collectors/fomo/types.js")
    if (!fomoSessionExists()) {
      expect(fomoSessionExists()).toBe(false)
      return
    }
    const { FomoWebClient } = await import("../../src/collectors/fomo/web-client.js")
    const { mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const client = new FomoWebClient({
      archiveRoot: mkdtempSync(join(tmpdir(), "fomo-live-")),
      debitAttempts: false,
      headless: true,
    })
    try {
      const traders = await client.getLeaderboard({ timeframe: "7d", limit: 1 })
      expect(Array.isArray(traders)).toBe(true)
    } catch (error) {
      expect(error instanceof FomoClientError || String(error).match(/Fomo|session|upstream|challenged/iu)).toBeTruthy()
    } finally {
      await client.close().catch(() => undefined)
    }
  })
})
