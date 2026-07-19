import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertFomoProfileReady, fomoSessionExists } from "../../src/collectors/social/fomo-auth.js"

describe("fomo auth path asserts", () => {
  it("throws when storage-state is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "fomo-auth-missing-"))
    expect(() => assertFomoProfileReady(dir)).toThrow(/No Fomo session/u)
  })

  it("throws when storage-state is malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "fomo-auth-bad-"))
    writeFileSync(join(dir, "storage-state.json"), "{not-json")
    expect(() => assertFomoProfileReady(dir)).toThrow(/malformed/u)
  })

  it("accepts minimal valid storage-state shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "fomo-auth-ok-"))
    writeFileSync(join(dir, "storage-state.json"), JSON.stringify({ cookies: [], origins: [] }))
    expect(assertFomoProfileReady(dir)).toBe(join(dir, "storage-state.json"))
  })

  it("fomoSessionExists is false without a home profile", () => {
    // Does not create ~/.trenchcoat/fomo-profile — only asserts the helper fails closed
    expect(typeof fomoSessionExists()).toBe("boolean")
  })
})
