import { describe, expect, it } from "vitest"
import {
  splitTelegramText,
  TELEGRAM_SAFE_CHUNK,
} from "../../src/lib/telegram-bot.js"
import { prepareTelegramReply } from "../../src/chat/telegram-reply.js"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("splitTelegramText", () => {
  it("returns a single part under the limit without numbering", () => {
    const parts = splitTelegramText("short reply")
    expect(parts).toEqual(["short reply"])
  })

  it("keeps text exactly at the limit as one part", () => {
    const body = "a".repeat(TELEGRAM_SAFE_CHUNK)
    expect(splitTelegramText(body)).toEqual([body])
  })

  it("splits at paragraph boundaries into numbered parts", () => {
    const p1 = "alpha\n\n" + "b".repeat(2_000)
    const p2 = "c".repeat(2_000)
    const parts = splitTelegramText(`${p1}\n\n${p2}`, 3_000)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts[0]?.startsWith("1/")).toBe(true)
    expect(parts.at(-1)?.startsWith(`${parts.length}/`)).toBe(true)
    const rejoined = parts.map((p) => p.replace(/^\d+\/\d+\n/u, "")).join("\n\n")
    expect(rejoined).toContain("alpha")
    expect(rejoined).toContain("b".repeat(2_000))
  })

  it("does not break fenced code blocks across parts when avoidable", () => {
    const code = "```\n" + "x".repeat(400) + "\n```"
    const before = "intro paragraph\n\n"
    const after = "\n\n" + "y".repeat(3_500)
    const parts = splitTelegramText(before + code + after, 2_000)
    const bodies = parts.map((p) => p.replace(/^\d+\/\d+\n/u, ""))
    const withFence = bodies.filter((b) => b.includes("```"))
    expect(withFence.length).toBeGreaterThanOrEqual(1)
    for (const body of withFence) {
      const marks = body.match(/^```/gmu) ?? []
      // A part that contains the fence unit should have matching open/close
      if (body.includes("```\nx") || body.includes("x\n```")) {
        expect(marks.length % 2).toBe(0)
      }
    }
  })

  it("hard-splits when there are no paragraph breaks", () => {
    const body = "word ".repeat(2_000).trim()
    const parts = splitTelegramText(body, 500)
    expect(parts.length).toBeGreaterThan(2)
    expect(parts.every((p) => p.length <= 500)).toBe(true)
    const rejoined = parts.map((p) => p.replace(/^\d+\/\d+\n/u, "")).join(" ")
    expect(rejoined.replace(/\s+/gu, " ")).toContain("word word")
  })
})

describe("prepareTelegramReply", () => {
  it("persists long replies under reports/chat and summarizes", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-tg-reply-"))
    const long = "para one\n\n" + "z".repeat(8_000)
    const prepared = await prepareTelegramReply({
      text: long,
      agentRoot: root,
      nowIso: "2026-07-18T12:00:00.000Z",
      longReportChars: 7_600,
    })
    expect(prepared.persistedPath).toMatch(/^reports\/chat\/chat-/u)
    expect(existsSync(join(root, prepared.persistedPath!))).toBe(true)
    expect(readFileSync(join(root, prepared.persistedPath!), "utf8")).toContain("para one")
    expect(prepared.parts.join("\n")).toContain("full reply at reports/chat/")
    expect(prepared.parts.join("\n").length).toBeLessThan(long.length)
  })
})
