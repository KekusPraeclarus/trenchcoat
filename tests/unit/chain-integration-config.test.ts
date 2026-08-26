import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateConfigToV29 } from "../../src/migrations/config.js"
import { ConfigSchema } from "../../src/lib/config.js"
import { readFileSync } from "node:fs"

const seed = JSON.parse(
  readFileSync(new URL("../../config/seed.example.json", import.meta.url), "utf8"),
)

describe("config schema 19 via chain_integration migration", () => {
  it("migrates schema 11 → 19 with chain_integration defaults", () => {
    const raw = { ...seed, schema: 11 }
    delete (raw as { chat?: { discord?: { chain_integration?: unknown } } })
      .chat?.discord?.chain_integration
    const migrated = migrateConfigToV29(raw)
    const parsed = ConfigSchema.parse(migrated)
    expect(parsed.schema).toBe(29)
    expect(parsed.incident_remediation.enabled).toBe(false)
    expect(parsed.chat.discord.chain_integration.enabled).toBe(true)
    expect(parsed.chat.discord.chain_integration.max_attempts_per_utc_day).toBe(3)
    expect(parsed.chat.discord.chain_integration.build_model).toBe("cursor-grok-4.5-high")
  })

  it("preserves explicit enabled:false", () => {
    const raw = {
      ...seed,
      schema: 11,
      chat: {
        ...seed.chat,
        discord: {
          ...seed.chat.discord,
          chain_integration: { enabled: false, max_attempts_per_utc_day: 1 },
        },
      },
    }
    const parsed = ConfigSchema.parse(migrateConfigToV29(raw))
    expect(parsed.chat.discord.chain_integration.enabled).toBe(false)
    expect(parsed.chat.discord.chain_integration.max_attempts_per_utc_day).toBe(1)
  })
})

describe("chain integration store", () => {
  it("round-trips index", async () => {
    const home = mkdtempSync(join(tmpdir(), "ci-store-"))
    try {
      const { chainIntegrationLayout } = await import("../../src/chain-integration/paths.js")
      const { createChainIntegrationStore, emptyIntegrationsFile } =
        await import("../../src/chain-integration/store.js")
      const layout = chainIntegrationLayout(home)
      const store = createChainIntegrationStore(layout)
      await store.save(emptyIntegrationsFile())
      expect(store.load().schema).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
