import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../../src/lib/config.js"
import {
  migrateConfigToV27,
  migrateConfigToV28,
  migrateConfigToV29,
  FOMO_FOLLOWS_V28_DEFAULTS,
} from "../../src/migrations/config.js"

const seed = JSON.parse(
  readFileSync(join(process.cwd(), "config/seed.example.json"), "utf8"),
) as Record<string, unknown>

function asV27(): Record<string, unknown> {
  const v27 = structuredClone(seed) as Record<string, unknown>
  v27["schema"] = 27
  const fomo = { ...(v27["fomo"] as Record<string, unknown>) }
  const trader = { ...(fomo["trader_sync"] as Record<string, unknown>) }
  trader["max_handles"] = 50
  fomo["trader_sync"] = trader
  delete fomo["follows"]
  v27["fomo"] = fomo
  return v27
}

describe("config migration v28", () => {
  it("upgrades schema 27 once to schema 28", () => {
    const migrated = migrateConfigToV28(asV27()) as Record<string, unknown>
    expect(migrated["schema"]).toBe(28)
  })

  it("is idempotent", () => {
    const once = migrateConfigToV28(asV27())
    const twice = migrateConfigToV28(once)
    expect(twice).toEqual(once)
  })

  it("cuts the old default max_handles and adds follow defaults", () => {
    const parsed = ConfigSchema.parse(migrateConfigToV29(asV27()))
    expect(parsed.fomo.trader_sync.max_handles).toBe(15)
    expect(parsed.fomo.follows.max_follows_per_run).toBe(
      FOMO_FOLLOWS_V28_DEFAULTS.max_follows_per_run,
    )
    expect(parsed.fomo.follows.max_following).toBe(FOMO_FOLLOWS_V28_DEFAULTS.max_following)
    expect(parsed.fomo.follows.enabled).toBe(false)
  })

  it("enables follows on a live non-shadow FOMO install", () => {
    const v27 = asV27()
    v27["fomo"] = {
      ...(v27["fomo"] as Record<string, unknown>),
      enabled: true,
      shadow_mode: false,
    }
    const parsed = ConfigSchema.parse(migrateConfigToV29(v27))
    expect(parsed.fomo.follows.enabled).toBe(true)
  })

  it("preserves an explicit custom max_handles", () => {
    const v27 = asV27()
    const fomo = v27["fomo"] as Record<string, unknown>
    fomo["trader_sync"] = {
      ...(fomo["trader_sync"] as Record<string, unknown>),
      max_handles: 20,
    }
    const parsed = ConfigSchema.parse(migrateConfigToV29(v27))
    expect(parsed.fomo.trader_sync.max_handles).toBe(20)
  })

  it("lifts schema 26 through v27 into parseable schema 29", () => {
    const v26 = structuredClone(asV27())
    v26["schema"] = 26
    delete v26["pump"]
    const parsed = ConfigSchema.parse(migrateConfigToV29(migrateConfigToV27(v26)))
    expect(parsed.schema).toBe(29)
    expect(parsed.fomo.trader_sync.max_handles).toBe(15)
  })
})
