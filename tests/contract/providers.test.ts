import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { fetchFearGreed } from "../../src/collectors/market/providers.js"
import type { FetchLike } from "../../src/collectors/market/geckoterminal.js"

describe("provider response contracts", () => {
  it("accepts Alternative.me's timestamped reading fixture", async () => {
    const fixture = readFileSync(join(process.cwd(), "tests/fixtures/providers/fear-greed.json"), "utf8")
    const fetcher: FetchLike = async () => new Response(fixture, {
      headers: { "content-type": "application/json" },
    })
    await expect(fetchFearGreed(fetcher, 1_700_000_100)).resolves.toEqual({
      value: 54,
      classification: "Neutral",
      timestamp: 1_700_000_000,
    })
  })
})
