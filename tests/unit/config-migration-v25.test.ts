import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../../src/lib/config.js"
import { DEPLOYMENT_CONFIG_SCHEMA } from "../../src/lib/deployment.js"
import { migrateConfigToV25, migrateConfigToV29 } from "../../src/migrations/config.js"

const seed = JSON.parse(
  readFileSync(join(process.cwd(), "config/seed.example.json"), "utf8"),
) as Record<string, unknown>

function asV24(): Record<string, unknown> {
  const v24 = structuredClone(seed) as Record<string, unknown>
  v24["schema"] = 24
  const retention = v24["retention"] as Record<string, unknown>
  delete retention["alpha_ack_days"]
  delete retention["narrative_dossier_days"]
  const research = v24["research"] as Record<string, unknown>
  delete research["social_cashtag_bridge"]
  delete v24["new_pools_feed"]
  return v24
}

describe("config migration v25", () => {
  it("upgrades schema 24 once and validates as schema 25", () => {
    const migrated = migrateConfigToV25(asV24()) as Record<string, unknown>
    expect(migrated["schema"]).toBe(25)
    expect(ConfigSchema.parse(migrateConfigToV29(migrated)).schema).toBe(29)
  })

  it("is idempotent", () => {
    const once = migrateConfigToV25(asV24())
    const twice = migrateConfigToV25(once)
    expect(twice).toEqual(once)
  })

  it("keeps the deployment config schema aligned", () => {
    expect(DEPLOYMENT_CONFIG_SCHEMA).toBe(29)
    expect(ConfigSchema.parse(seed).schema).toBe(DEPLOYMENT_CONFIG_SCHEMA)
  })

  it("adds retention sweep defaults for an existing installation", () => {
    const parsed = ConfigSchema.parse(migrateConfigToV29(migrateConfigToV25(asV24())))
    expect(parsed.retention.alpha_ack_days).toBe(30)
    expect(parsed.retention.narrative_dossier_days).toBe(120)
  })

  it("preserves explicit schema 24 retention values", () => {
    const v24 = asV24()
    const retention = v24["retention"] as Record<string, unknown>
    retention["alpha_ack_days"] = 7
    retention["narrative_dossier_days"] = 365
    const parsed = ConfigSchema.parse(migrateConfigToV29(migrateConfigToV25(v24)))
    expect(parsed.retention.alpha_ack_days).toBe(7)
    expect(parsed.retention.narrative_dossier_days).toBe(365)
  })

  it("keeps the existing retention windows", () => {
    const parsed = ConfigSchema.parse(migrateConfigToV29(migrateConfigToV25(asV24())))
    expect(parsed.retention.inbox_archive_days).toBe(30)
    expect(parsed.retention.run_archive_days).toBe(90)
    expect(parsed.retention.chat_reports_days).toBe(30)
  })
})
