import { describe, expect, it } from "vitest"
import {
  DISCORD_SAFE_CHUNK,
  deliverDiscord,
  discordPartIdempotencyKey,
  splitDiscordText,
} from "../../src/router/deliver.js"
import type { FetchLike } from "../../src/collectors/market/geckoterminal.js"

describe("splitDiscordText", () => {
  it("returns a single part under the limit without numbering", () => {
    expect(splitDiscordText("short")).toEqual(["short"])
  })

  it("splits long payloads into numbered parts under the Discord limit", () => {
    const body = Array.from({ length: 5 }, (_, i) => `para ${i}\n\n${"x".repeat(800)}`).join("\n\n")
    const parts = splitDiscordText(body)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((p) => p.length <= DISCORD_SAFE_CHUNK)).toBe(true)
    expect(parts[0]?.startsWith("1/")).toBe(true)
    expect(parts.at(-1)?.startsWith(`${parts.length}/`)).toBe(true)
  })

  it("soft cap stays under Discord's 2000 hard limit", () => {
    expect(DISCORD_SAFE_CHUNK).toBeLessThan(2_000)
  })

  it("hard-splits a single block exceeding 2000 chars into multiple parts", () => {
    // No paragraph boundaries: exercises the hard-split fallback path
    const parts = splitDiscordText("z".repeat(5_000))
    expect(parts.length).toBeGreaterThan(1)
    // Each part carries an `n/m\n` prefix yet still fits Discord's hard limit
    expect(parts.every((p) => p.length < 2_000)).toBe(true)
    parts.forEach((p, i) => expect(p.startsWith(`${i + 1}/${parts.length}\n`)).toBe(true))
  })
})

describe("discordPartIdempotencyKey", () => {
  it("builds stable per-part keys", () => {
    expect(discordPartIdempotencyKey("deliv-1", 0, 3)).toBe("deliv-1:part:1/3")
    expect(discordPartIdempotencyKey("deliv-1", 2, 3)).toBe("deliv-1:part:3/3")
  })

  it("rejects unsafe ids", () => {
    expect(() => discordPartIdempotencyKey("bad id", 0, 1)).toThrow(/unsafe/i)
  })

  it("produces a unique stable key per part across a multipart delivery", () => {
    const total = 4
    const keys = Array.from({ length: total }, (_, i) =>
      discordPartIdempotencyKey("deliv-1", i, total),
    )
    expect(new Set(keys).size).toBe(total)
    expect(keys).toEqual([
      "deliv-1:part:1/4",
      "deliv-1:part:2/4",
      "deliv-1:part:3/4",
      "deliv-1:part:4/4",
    ])
    // Same inputs re-derive identical keys (idempotent across retries)
    expect(discordPartIdempotencyKey("deliv-1", 2, total)).toBe(keys[2])
  })

  it("rejects out-of-range part indices", () => {
    expect(() => discordPartIdempotencyKey("deliv-1", 3, 3)).toThrow(/range/i)
    expect(() => discordPartIdempotencyKey("deliv-1", -1, 3)).toThrow(/range/i)
  })
})

describe("deliverDiscord", () => {
  it("posts numbered chunks with stable Idempotency-Key headers", async () => {
    const seen: Array<{ content: string; key?: string }> = []
    const fetcher: FetchLike = async (_url, init) => {
      const headers = new Headers(init?.headers)
      const body = JSON.parse(String(init?.body ?? "{}")) as { content?: string }
      seen.push({
        content: body.content ?? "",
        ...(headers.get("Idempotency-Key")
          ? { key: headers.get("Idempotency-Key")! }
          : {}),
      })
      return new Response("{}", { status: 200 })
    }
    const text = `${"a".repeat(1_200)}\n\n${"b".repeat(1_200)}`
    await deliverDiscord(fetcher, "https://discord.example/webhook", text, {
      idempotencyKeyBase: "d-abc",
    })
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.every((s) => s.content.length <= DISCORD_SAFE_CHUNK)).toBe(true)
    expect(seen[0]?.key).toBe(`d-abc:part:1/${seen.length}`)
    expect(seen.at(-1)?.key).toBe(`d-abc:part:${seen.length}/${seen.length}`)
  })
})
