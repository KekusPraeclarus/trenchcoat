import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import { sanitizePathSegment, assertPathInside } from "../../src/lib/snapshot.js"
import { RateGate } from "../../src/lib/rate-gate.js"
import { migrateConfigToV4 } from "../../src/migrations/config.js"
import { ConfigSchema } from "../../src/lib/config.js"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("prop_inv_i4_sanitize", () => {
  it("rejects unsafe segments", () => {
    fc.assert(fc.property(fc.string(), (s) => {
      const safe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(s)
      if (safe) {
        expect(sanitizePathSegment(s)).toBe(s)
      } else {
        expect(() => sanitizePathSegment(s)).toThrow()
      }
    }))
  })

  it("keeps resolved paths inside root", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-root-"))
    expect(assertPathInside(root, join(root, "a"))).toContain(root)
    expect(() => assertPathInside(root, join(root, "..", "escape"))).toThrow()
  })
})

describe("prop_inv_r1_rate_gate", () => {
  it("never goes negative on take", async () => {
    const gate = new RateGate("example.test", { capacity: 2, refillPerSecond: 100 })
    await gate.take(1)
    await gate.take(1)
    const snap = gate.snapshot()
    expect(snap.tokens).toBeGreaterThanOrEqual(0)
  })
})

describe("config migration", () => {
  it("lifts v1 into parseable v4", () => {
    const v4 = migrateConfigToV4({
      schema: 1,
      telegram_channels: ["alpha"],
      twitter: { max_pages_per_run: 3 },
    })
    expect(ConfigSchema.parse(v4).schema).toBe(4)
  })
})
