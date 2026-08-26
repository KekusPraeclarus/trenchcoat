import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../../src/lib/config.js"
import { migrateConfigToV20, migrateConfigToV29, WALLET_SIGNALS_V20_DEFAULTS } from "../../src/migrations/config.js"

const seed = JSON.parse(
  readFileSync(join(process.cwd(), "config/seed.example.json"), "utf8"),
) as Record<string, unknown>

describe("config migration v20", () => {
  it("injects wallet_signals defaults from schema 19", () => {
    const v19 = {
      ...seed,
      schema: 19,
      chat: {
        ...(seed["chat"] as Record<string, unknown>),
        discord: {
          ...((seed["chat"] as Record<string, unknown>)["discord"] as Record<string, unknown>),
        },
      },
    }
    delete (v19["chat"] as Record<string, unknown> & {
      discord: Record<string, unknown>
    }).discord["wallet_signals"]

    const migrated = migrateConfigToV20(v19) as Record<string, unknown>
    expect(migrated["schema"]).toBe(20)
    const discord = ((migrated["chat"] as Record<string, unknown>)["discord"]
      ?? {}) as Record<string, unknown>
    const walletSignals = discord["wallet_signals"] as Record<string, unknown>
    expect(walletSignals["enabled"]).toBe(false)
    expect(walletSignals["shadow_mode"]).toBe(true)
    expect(walletSignals["channel_ids"]).toEqual([])
    expect(walletSignals["scan_interval_minutes"]).toBe(
      WALLET_SIGNALS_V20_DEFAULTS.scan_interval_minutes,
    )
    expect(ConfigSchema.parse(migrateConfigToV29(migrated)).schema).toBe(29)
  })

  it("rejects overlapping research and wallet_signals channels when enabled", () => {
    const overlapping = structuredClone(seed) as Record<string, unknown>
    const discord = ((overlapping["chat"] as Record<string, unknown>)["discord"]
      ?? {}) as Record<string, unknown>
    discord["channel_ids"] = ["1000000000000000003"]
    discord["wallet_signals"] = {
      enabled: true,
      shadow_mode: true,
      channel_ids: ["1000000000000000003"],
    }
    expect(() => ConfigSchema.parse(overlapping)).toThrow(/disjoint/)
  })

  it("parses seed with wallet_signals enabled and disjoint channels", () => {
    const parsed = ConfigSchema.parse(seed)
    expect(parsed.chat.discord.wallet_signals.enabled).toBe(true)
    expect(parsed.chat.discord.wallet_signals.channel_ids).toEqual([
      "1000000000000000003",
      "1000000000000000004",
    ])
  })
})
