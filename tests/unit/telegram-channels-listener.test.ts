import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  acceptChannelMessage,
  loadChannelCursors,
  runTelegramChannelsListener,
} from "../../src/collectors/telegram/channels.js"

describe("telegram channels listener resilience", () => {
  it("idles when gramjs session is missing instead of crashing", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-channels-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "alpha-queue"), { recursive: true })
    const ac = new AbortController()
    const done = runTelegramChannelsListener({
      agentRoot,
      home: root,
      channels: [{ channel: "privatechan", mode: "gramjs" }],
      pollIntervalMs: 50,
      signal: ac.signal,
      fetcher: async () => new Response("<html></html>", { status: 200 }),
    })
    await new Promise((r) => setTimeout(r, 80))
    ac.abort()
    await expect(done).resolves.toBeUndefined()
    expect(existsSync(join(root, "telegram-session", "session.txt"))).toBe(false)
  })

  it("advances durable cursors and does not duplicate queue writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-cursor-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "alpha-queue"), { recursive: true })
    const cursorsFilePath = join(root, "telegram-channels", "cursors.json")
    mkdirSync(join(root, "telegram-channels"), { recursive: true })
    writeFileSync(cursorsFilePath, `${JSON.stringify({ schema: 1, channels: {} }, null, 2)}\n`)

    const message = {
      id: "42",
      channel: "publicpreview",
      text: "hello",
      timestamp: "2026-07-18T00:00:00.000Z",
      url: "https://t.me/publicpreview/42",
      provenance: "telegram:publicpreview",
    }
    const first = await acceptChannelMessage({
      agentRoot,
      message,
      cursorsFilePath,
      nowIso: "2026-07-18T00:00:00.000Z",
    })
    const second = await acceptChannelMessage({
      agentRoot,
      message,
      cursorsFilePath,
      nowIso: "2026-07-18T00:01:00.000Z",
    })
    expect(first.written).toBe(true)
    expect(second.written).toBe(false)
    expect(first.cursorAdvanced).toBe(true)
    expect(second.cursorAdvanced).toBe(true)
    const cursors = loadChannelCursors(cursorsFilePath)
    expect(cursors.channels["publicpreview"]?.lastId).toBe("42")
  })

  it("invokes onNewMessage only for newly written queue files", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-onnew-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "alpha-queue"), { recursive: true })
    const notified: string[] = []
    const html = `
      <div class="tgme_widget_message_wrap">
        <div class="tgme_widget_message" data-post="alpha/7">
          <div class="tgme_widget_message_text">signal</div>
          <time datetime="2026-07-20T12:00:00+00:00"></time>
        </div>
      </div>
    `
    const ac = new AbortController()
    const done = runTelegramChannelsListener({
      agentRoot,
      home: root,
      channels: [{ channel: "alpha", mode: "preview" }],
      pollIntervalMs: 30,
      signal: ac.signal,
      fetcher: async () => new Response(html, { status: 200 }),
      onNewMessage: ({ queuePath }) => {
        notified.push(queuePath)
      },
    })
    await new Promise((r) => setTimeout(r, 80))
    ac.abort()
    await expect(done).resolves.toBeUndefined()
    expect(notified).toEqual(["alpha-queue/alpha/7.json"])
  })
})
