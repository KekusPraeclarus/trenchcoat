import { describe, expect, it } from "vitest"

const live = process.env["TRENCHCOAT_LIVE_PUMP"] === "1"

describe.runIf(live)("live pump read-only", () => {
  it("session assert or typed client error", async () => {
    const { pumpSessionExists } = await import("../../src/collectors/social/pump-auth.js")
    const { PumpClientError } = await import("../../src/collectors/pump/types.js")
    if (!pumpSessionExists()) {
      expect(pumpSessionExists()).toBe(false)
      return
    }
    const { PumpWebClient } = await import("../../src/collectors/pump/web-client.js")
    const { mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const client = new PumpWebClient({
      archiveRoot: mkdtempSync(join(tmpdir(), "pump-live-")),
      headless: true,
    })
    try {
      const items = await client.readFeed({ tab: "fyp", maxPages: 1 })
      expect(Array.isArray(items)).toBe(true)
    } catch (error) {
      expect(
        error instanceof PumpClientError
        || String(error).match(/pump|session|upstream|challenged/iu),
      ).toBeTruthy()
    } finally {
      await client.close().catch(() => undefined)
    }
  })
})
