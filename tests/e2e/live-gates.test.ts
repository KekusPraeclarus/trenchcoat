import { describe, expect, it } from "vitest"

const live = process.env["TRENCHCOAT_LIVE_E2E"] === "1"

describe.runIf(live)("live e2e gates", () => {
  it("requires credentials for live suite", () => {
    const required = [
      "TRENCHCOAT_ROUTER_HMAC_KEY",
      "TELEGRAM_BOT_TOKEN",
      "HELIUS_API_KEY",
      "INFURA_API_KEY",
    ] as const
    const missing = required.filter((key) => !process.env[key]?.trim())
    expect(missing, `missing env (is .env loaded?): ${missing.join(", ")}`).toEqual([])
  })

  it("managed list config is present or creatable", async () => {
    const { loadConfig } = await import("../../src/lib/config.js")
    const { existsSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { homedir } = await import("node:os")
    const cfg = loadConfig()
    expect(cfg.twitter.operator_list_urls).toHaveLength(2)
    expect(cfg.twitter.scrape_home).toBe(true)
    expect(cfg.twitter.engagement.enabled).toBeTypeOf("boolean")
    const session = join(homedir(), ".trenchcoat", "twitter-profile", "storage-state.json")
    expect(existsSync(session), "run: pnpm dev:cli auth twitter").toBe(true)
    // Live create/add/remove is operator-driven via:
    //   pnpm dev:cli auth twitter --create-managed-list
    //   pnpm dev:cli source-list review --dry-run
    //   pnpm dev:cli x-engagement dry-run <run-id>
    if (cfg.twitter.managed_list.list_id) {
      expect(cfg.twitter.managed_list.list_url).toContain(cfg.twitter.managed_list.list_id)
    }
  })
})

describe.runIf(!live)("live e2e placeholder", () => {
  it("skips when TRENCHCOAT_LIVE_E2E is not set", () => {
    expect(live).toBe(false)
  })
})
