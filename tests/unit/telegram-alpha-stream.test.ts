import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createTelegramAlphaPump,
  alphaQueueRelativePath,
  runTelegramAlphaPass,
} from "../../src/orchestrator/telegram-alpha.js"
import {
  acceptChannelMessage,
  runTelegramChannelsListener,
} from "../../src/collectors/telegram/channels.js"

describe("telegram-alpha paths", () => {
  it("builds relative alpha-queue paths", () => {
    expect(alphaQueueRelativePath("Chan", "42")).toBe("alpha-queue/Chan/42.json")
  })
})

describe("telegram-alpha pump", () => {
  it("serializes passes and dedupes pending paths", async () => {
    const calls: string[][] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const pump = createTelegramAlphaPump({
      paths: { agentRoot: "/tmp", archiveRoot: "/tmp" },
      runPass: async ({ queuePaths }) => {
        calls.push([...queuePaths])
        await gate
        return {
          runId: "r1",
          journal: { schema: 1, runId: "r1", job: "telegram-alpha", phase: "complete", createdAt: "", updatedAt: "", sideEffects: [] } as never,
          exitCode: 0,
        }
      },
    })
    pump.enqueue("alpha-queue/a/1.json")
    pump.enqueue("alpha-queue/a/1.json")
    pump.enqueue("alpha-queue/a/2.json")
    expect(pump.pending()).toBeGreaterThanOrEqual(1)
    release()
    await new Promise((r) => setTimeout(r, 30))
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls.flat()).toContain("alpha-queue/a/1.json")
  })

  it("rethrows path escapes from runTelegramAlphaPass", async () => {
    await expect(runTelegramAlphaPass({
      paths: { agentRoot: "/tmp", archiveRoot: "/tmp" },
      queuePaths: ["../etc/passwd"],
    })).rejects.toThrow(/alpha-queue/)
  })
})

describe("channels listener → onNewMessage", () => {
  it("notifies only newly written messages", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-tg-alpha-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "alpha-queue"), { recursive: true })
    const seen: string[] = []
    const html = `
      <div class="tgme_widget_message_wrap">
        <div data-post="alpha/99"></div>
        <time datetime="2026-07-20T00:00:00.000Z"></time>
        <div class="tgme_widget_message_text">call solana:So11111111111111111111111111111111111111112</div>
      </div>
      <div class="tgme_widget_message_wrap">
        <div data-post="alpha/99"></div>
        <time datetime="2026-07-20T00:00:00.000Z"></time>
        <div class="tgme_widget_message_text">call solana:So11111111111111111111111111111111111111112</div>
      </div>
    `
    const ac = new AbortController()
    const done = runTelegramChannelsListener({
      agentRoot,
      home: root,
      channels: [{ channel: "alpha", mode: "preview" }],
      pollIntervalMs: 20,
      signal: ac.signal,
      fetcher: async () => new Response(html, { status: 200 }),
      onNewMessage: ({ queuePath }) => {
        seen.push(queuePath)
      },
    })
    await new Promise((r) => setTimeout(r, 80))
    ac.abort()
    await done
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0]).toBe("alpha-queue/alpha/99.json")
    // Second poll should not re-notify the same message
    const unique = new Set(seen)
    expect(unique.size).toBe(1)
  })

  it("acceptChannelMessage returns queuePath", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-accept-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "alpha-queue"), { recursive: true })
    const cursorsFilePath = join(root, "cursors.json")
    const result = await acceptChannelMessage({
      agentRoot,
      cursorsFilePath,
      message: {
        id: "7",
        channel: "pub",
        text: "hi",
        timestamp: "2026-07-20T00:00:00.000Z",
        url: "https://t.me/pub/7",
        provenance: "telegram:pub",
      },
    })
    expect(result.written).toBe(true)
    expect(result.queuePath).toBe("alpha-queue/pub/7.json")
  })
})

describe("research drain scheduling", () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("kicks runJob research after scheduleResearchDrain", async () => {
    const runJob = vi.fn(async () => ({
      runId: "none",
      journal: { schema: 1, runId: "none", job: "research", phase: "complete", createdAt: "", updatedAt: "", sideEffects: [] },
      exitCode: 0,
    }))
    vi.doMock("../../src/orchestrator/run.js", () => ({ runJob }))
    const { scheduleResearchDrain, resetResearchDrainForTests } = await import(
      "../../src/orchestrator/research-drain.js"
    )
    resetResearchDrainForTests()
    scheduleResearchDrain({ agentRoot: "/tmp/a", archiveRoot: "/tmp/ar" })
    await new Promise((r) => setTimeout(r, 50))
    expect(runJob).toHaveBeenCalledWith(expect.objectContaining({
      job: "research",
      paths: { agentRoot: "/tmp/a", archiveRoot: "/tmp/ar" },
    }))
  })
})
