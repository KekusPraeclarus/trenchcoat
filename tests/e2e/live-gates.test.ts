import { describe, expect, it } from "vitest"

const live = process.env["TRENCHCOAT_LIVE_E2E"] === "1"

describe.runIf(live)("live e2e gates", () => {
  it("requires credentials for live suite", () => {
    for (const key of [
      "CURSOR_API_KEY",
      "TRENCHCOAT_ROUTER_HMAC_KEY",
      "TELEGRAM_BOT_TOKEN",
      "HELIUS_API_KEY",
      "INFURA_API_KEY",
    ]) {
      expect(process.env[key]?.trim().length).toBeGreaterThan(0)
    }
  })
})

describe.runIf(!live)("live e2e placeholder", () => {
  it("skips when TRENCHCOAT_LIVE_E2E is not set", () => {
    expect(live).toBe(false)
  })
})
