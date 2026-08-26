import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../../src/lib/config.js"
import {
  migrateConfigToV24,
  migrateConfigToV29,
} from "../../src/migrations/config.js"

const seed = JSON.parse(
  readFileSync(join(process.cwd(), "config/seed.example.json"), "utf8"),
) as Record<string, unknown>

function asV23(): Record<string, unknown> {
  const v23 = structuredClone(seed) as Record<string, unknown>
  v23["schema"] = 23
  const remediation = v23["incident_remediation"] as Record<string, unknown>
  const suggestions = remediation["discord_suggestions"] as Record<string, unknown>
  delete suggestions["followup_enabled"]
  return v23
}

describe("config migration v24", () => {
  it("upgrades schema 23 once to schema 24", () => {
    const migrated = migrateConfigToV24(asV23()) as Record<string, unknown>
    expect(migrated["schema"]).toBe(24)
    expect(ConfigSchema.parse(migrateConfigToV29(migrated)).schema).toBe(29)
  })

  it("is idempotent", () => {
    const once = migrateConfigToV24(asV23())
    const twice = migrateConfigToV24(once)
    expect(twice).toEqual(once)
  })

  it("turns the suggestion followup on for an existing installation", () => {
    const parsed = ConfigSchema.parse(migrateConfigToV29(asV23()))
    expect(parsed.incident_remediation.discord_suggestions.followup_enabled).toBe(true)
  })

  it("preserves an explicit schema 23 followup value", () => {
    const v23 = asV23()
    const remediation = v23["incident_remediation"] as Record<string, unknown>
    const suggestions = remediation["discord_suggestions"] as Record<string, unknown>
    suggestions["followup_enabled"] = false
    const parsed = ConfigSchema.parse(migrateConfigToV29(v23))
    expect(parsed.incident_remediation.discord_suggestions.followup_enabled).toBe(false)
  })

  it("keeps other suggestion settings", () => {
    const v23 = asV23()
    const remediation = v23["incident_remediation"] as Record<string, unknown>
    const suggestions = remediation["discord_suggestions"] as Record<string, unknown>
    suggestions["min_confidence"] = 0.9
    const parsed = ConfigSchema.parse(migrateConfigToV29(v23))
    expect(parsed.incident_remediation.discord_suggestions.min_confidence).toBe(0.9)
  })
})
