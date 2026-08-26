import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../../src/lib/config.js"
import { DEPLOYMENT_CONFIG_SCHEMA } from "../../src/lib/deployment.js"
import { migrateConfigToV28, migrateConfigToV29 } from "../../src/migrations/config.js"

const seed = JSON.parse(
  readFileSync(join(process.cwd(), "config/seed.example.json"), "utf8"),
) as Record<string, unknown>

function asV28(): Record<string, unknown> {
  const v28 = structuredClone(seed) as Record<string, unknown>
  v28["schema"] = 28
  const broadcast = { ...(v28["broadcast"] as Record<string, unknown>) }
  broadcast["feedback"] = {
    ...((broadcast["feedback"] ?? {}) as Record<string, unknown>),
    history_days: 30,
  }
  v28["broadcast"] = broadcast
  return v28
}

describe("config migration v29", () => {
  it("upgrades schema 28 once and validates as schema 29", () => {
    const migrated = migrateConfigToV29(asV28()) as Record<string, unknown>
    expect(migrated["schema"]).toBe(29)
    expect(ConfigSchema.parse(migrated).schema).toBe(29)
  })

  it("is idempotent", () => {
    const once = migrateConfigToV29(asV28())
    const twice = migrateConfigToV29(once)
    expect(twice).toEqual(once)
  })

  it("keeps the deployment config schema aligned", () => {
    expect(DEPLOYMENT_CONFIG_SCHEMA).toBe(29)
    expect(ConfigSchema.parse(seed).schema).toBe(DEPLOYMENT_CONFIG_SCHEMA)
  })

  it("raises the old default history_days to 60", () => {
    const parsed = ConfigSchema.parse(migrateConfigToV29(asV28()))
    expect(parsed.broadcast.feedback.history_days).toBe(60)
  })

  it("preserves a custom history_days value", () => {
    const v28 = asV28()
    const broadcast = v28["broadcast"] as Record<string, unknown>
    broadcast["feedback"] = {
      ...(broadcast["feedback"] as Record<string, unknown>),
      history_days: 45,
    }
    const parsed = ConfigSchema.parse(migrateConfigToV29(v28))
    expect(parsed.broadcast.feedback.history_days).toBe(45)
  })

  it("lifts schema 28 through v28 into parseable schema 29", () => {
    const parsed = ConfigSchema.parse(migrateConfigToV29(migrateConfigToV28(asV28())))
    expect(parsed.schema).toBe(29)
    expect(parsed.broadcast.feedback.history_days).toBe(60)
  })
})
