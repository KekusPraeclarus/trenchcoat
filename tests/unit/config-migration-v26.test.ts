import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../../src/lib/config.js"
import { DEPLOYMENT_CONFIG_SCHEMA } from "../../src/lib/deployment.js"
import {
  migrateConfigToV25,
  migrateConfigToV26,
  migrateConfigToV27,
  migrateConfigToV28,
} from "../../src/migrations/config.js"

const seed = JSON.parse(
  readFileSync(join(process.cwd(), "config/seed.example.json"), "utf8"),
) as Record<string, unknown>

function asV25(): Record<string, unknown> {
  const v25 = structuredClone(seed) as Record<string, unknown>
  v25["schema"] = 25
  const research = v25["research"] as Record<string, unknown>
  delete research["social_cashtag_bridge"]
  delete v25["new_pools_feed"]
  return v25
}

describe("config migration v26", () => {
  it("upgrades schema 25 once and validates as schema 26", () => {
    const migrated = migrateConfigToV26(asV25()) as Record<string, unknown>
    expect(migrated["schema"]).toBe(26)
    expect(ConfigSchema.parse(migrateConfigToV28(migrated)).schema).toBe(28)
  })

  it("is idempotent", () => {
    const once = migrateConfigToV26(asV25())
    const twice = migrateConfigToV26(once)
    expect(twice).toEqual(once)
  })

  it("keeps the deployment config schema aligned", () => {
    expect(DEPLOYMENT_CONFIG_SCHEMA).toBe(28)
    expect(ConfigSchema.parse(seed).schema).toBe(DEPLOYMENT_CONFIG_SCHEMA)
  })

  it("adds cashtag bridge and new-pools defaults for an existing installation", () => {
    const parsed = ConfigSchema.parse(migrateConfigToV28(migrateConfigToV26(asV25())))
    expect(parsed.research.social_cashtag_bridge.enabled).toBe(true)
    expect(parsed.research.social_cashtag_bridge.min_authors).toBe(2)
    expect(parsed.research.social_cashtag_bridge.window_days).toBe(7)
    expect(parsed.research.social_cashtag_bridge.max_enqueues_per_run).toBe(3)
    expect(parsed.research.social_cashtag_bridge.max_clusters).toBe(500)
    expect(parsed.research.social_cashtag_bridge.skip_promotional).toBe(true)
    expect(parsed.new_pools_feed.enabled).toBe(true)
    expect(parsed.new_pools_feed.shadow_mode).toBe(false)
    expect(parsed.new_pools_feed.chains).toEqual([
      "solana",
      "ethereum",
      "base",
      "robinhood",
    ])
    expect(parsed.new_pools_feed.max_enqueues_per_run).toBe(3)
    expect(parsed.new_pools_feed.max_enqueues_per_day).toBe(5)
    expect(parsed.new_pools_feed.min_pool_age_minutes).toBe(15)
    expect(parsed.new_pools_feed.max_pool_age_hours).toBe(24)
  })

  it("preserves explicit schema 25 discovery values", () => {
    const v25 = asV25()
    const research = v25["research"] as Record<string, unknown>
    research["social_cashtag_bridge"] = {
      enabled: false,
      min_authors: 3,
      window_days: 5,
      max_enqueues_per_run: 2,
      max_clusters: 100,
      skip_promotional: false,
    }
    v25["new_pools_feed"] = {
      enabled: false,
      shadow_mode: true,
      chains: ["solana", "base"],
      gecko_page: 2,
      max_candidates_per_run: 20,
      max_enqueues_per_run: 1,
      max_enqueues_per_day: 2,
      min_pool_age_minutes: 30,
      max_pool_age_hours: 12,
    }
    const parsed = ConfigSchema.parse(migrateConfigToV28(v25))
    expect(parsed.research.social_cashtag_bridge.enabled).toBe(false)
    expect(parsed.research.social_cashtag_bridge.min_authors).toBe(3)
    expect(parsed.new_pools_feed.enabled).toBe(false)
    expect(parsed.new_pools_feed.shadow_mode).toBe(true)
    expect(parsed.new_pools_feed.chains).toEqual(["solana", "base"])
    expect(parsed.new_pools_feed.min_pool_age_minutes).toBe(30)
  })

  it("lifts schema 24 through v25 into parseable schema 26", () => {
    const v24 = structuredClone(asV25())
    v24["schema"] = 24
    const retention = v24["retention"] as Record<string, unknown>
    delete retention["alpha_ack_days"]
    delete retention["narrative_dossier_days"]
    const parsed = ConfigSchema.parse(migrateConfigToV28(migrateConfigToV26(v24)))
    expect(parsed.schema).toBe(28)
    expect(parsed.retention.alpha_ack_days).toBe(30)
    expect(parsed.new_pools_feed.enabled).toBe(true)
  })

  it("rejects age bounds that invert", () => {
    const bad = structuredClone(seed) as Record<string, unknown>
    const feed = bad["new_pools_feed"] as Record<string, unknown>
    feed["min_pool_age_minutes"] = 60
    feed["max_pool_age_hours"] = 1
    expect(() => ConfigSchema.parse(bad)).toThrow(/min_pool_age_minutes/)
  })

  it("validates configured new-pools chains against the registry", () => {
    const parsed = ConfigSchema.parse(seed)
    for (const slug of parsed.new_pools_feed.chains) {
      expect(["solana", "ethereum", "base", "robinhood"]).toContain(slug)
    }
  })
})
