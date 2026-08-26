import { describe, expect, it, vi } from "vitest"
import {
  digestMarkdownCaptionFromText,
  digestMarkdownFilenameFromText,
  splitDailyDigestTelegramText,
  splitTelegramText,
  TELEGRAM_SAFE_CHUNK,
  telegramSendDocument,
  telegramSendFormattedChunks,
} from "../../src/lib/telegram-bot.js"
import { deliverTelegram } from "../../src/router/deliver.js"
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

describe("splitDailyDigestTelegramText", () => {
  it("keeps digest sections intact across multiple messages without page labels", () => {
    const sectionA = "**RH Chain Meme Rotation — peaking**\n\n" + "a".repeat(2_500)
    const sectionB = "**Pons Launchpad Attention — peaking**\n\n" + "b".repeat(2_500)
    const digest = [
      "**Daily narrative map — 2026-07-28**",
      sectionA,
      sectionB,
    ].join("\n\n")
    const parts = splitDailyDigestTelegramText(digest, 3_000)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((part) => !/^\d+\/\d+\n/u.test(part))).toBe(true)
    expect(parts.some((part) => part.includes("RH Chain Meme Rotation"))).toBe(true)
    expect(parts.some((part) => part.includes("Pons Launchpad Attention"))).toBe(true)
    for (const part of parts) {
      const hasAStart = part.includes("RH Chain Meme Rotation")
      const hasBStart = part.includes("Pons Launchpad Attention")
      expect(!(hasAStart && hasBStart)).toBe(true)
    }
  })
})

describe("digest markdown file helpers", () => {
  it("names the file from the digest title date", () => {
    const text = "**Daily narrative map — 2026-08-25**\n\n**RH — peaking**\n\nStill live."
    expect(digestMarkdownFilenameFromText(text)).toBe("daily-narrative-map-2026-08-25.md")
    expect(digestMarkdownCaptionFromText(text)).toBe("Daily narrative map — 2026-08-25")
  })
})

describe("telegramSendDocument", () => {
  it("posts multipart sendDocument without truncation", async () => {
    let url = ""
    let body: FormData | undefined
    const fetcher = vi.fn(async (target, init) => {
      url = String(target)
      body = init?.body as FormData
      return new Response(JSON.stringify({ result: { message_id: 3 } }), { status: 200 })
    })
    const result = await telegramSendDocument(fetcher, "token", "99", {
      filename: "daily-narrative-map-2026-08-25.md",
      bytes: "# map\n",
      caption: "Daily narrative map — 2026-08-25",
    })
    expect(result.messageId).toBe("3")
    expect(url).toContain("/sendDocument")
    expect(body).toBeInstanceOf(FormData)
    expect(body?.get("chat_id")).toBe("99")
    expect(body?.get("caption")).toBe("Daily narrative map — 2026-08-25")
    const file = body?.get("document")
    expect(file).toBeInstanceOf(File)
    expect((file as File).name).toBe("daily-narrative-map-2026-08-25.md")
  })
})

describe("deliverTelegram daily digest", () => {
  it("sends section chunks and a raw markdown file", async () => {
    const methods: string[] = []
    const fetcher = vi.fn(async (target) => {
      methods.push(String(target))
      return new Response(JSON.stringify({ result: { message_id: 1 } }), { status: 200 })
    })
    const text = "**Daily narrative map — 2026-08-25**\n\n**RH — peaking**\n\nStill live."
    const result = await deliverTelegram(fetcher, "token", "chan", text, { dailyDigest: true })
    expect(methods.some((url) => url.includes("/sendMessage"))).toBe(true)
    expect(methods.some((url) => url.includes("/sendDocument"))).toBe(true)
    expect(result.messageIds.length).toBeGreaterThanOrEqual(2)
  })
})

describe("telegramSendFormattedChunks", () => {
  it("sends markdown as HTML with parse_mode", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetcher = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")))
      return new Response("{}", { status: 200 })
    })
    await telegramSendFormattedChunks(fetcher, "token", "42", "**RH AI agents** — emerging")
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({
      chat_id: "42",
      text: "<b>RH AI agents</b> — emerging",
      parse_mode: "HTML",
    })
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
    expect(prepared.parts.join("\n")).toContain("full reply saved on host")
    expect(prepared.parts.join("\n")).not.toContain("reports/chat/")
    expect(prepared.parts.join("\n").length).toBeLessThan(long.length)
  })
})
