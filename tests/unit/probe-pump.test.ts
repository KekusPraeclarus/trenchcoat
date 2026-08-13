import { describe, expect, it } from "vitest"
import { sanitizeCapturedJson } from "../../src/collectors/pump/sanitize.js"

describe("probe-pump sanitize", () => {
  it("strips cookies, auth, and wallet secret fields", () => {
    const sanitized = sanitizeCapturedJson({
      items: [{ id: "a", mint: "x" }],
      headers: {
        "set-cookie": "sid=abc",
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      wallet: "secret-wallet",
      privateKey: "drop-me",
    }) as Record<string, unknown>
    const headers = sanitized["headers"] as Record<string, unknown>
    expect(headers["content-type"]).toBe("application/json")
    expect(headers["set-cookie"]).toBeUndefined()
    expect(headers["authorization"]).toBeUndefined()
    expect(sanitized["wallet"]).toBeUndefined()
    expect(sanitized["privateKey"]).toBeUndefined()
    expect(sanitized["items"]).toEqual([{ id: "a", mint: "x" }])
  })
})
