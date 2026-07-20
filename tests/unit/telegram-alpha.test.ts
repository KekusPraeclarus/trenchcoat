import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  alphaQueueRelativePath,
  createTelegramAlphaPump,
} from "../../src/orchestrator/telegram-alpha.js"

describe("telegram-alpha path helpers", () => {
  it("builds confined alpha-queue relative paths", () => {
    expect(alphaQueueRelativePath("AlphaChan", "99")).toBe(
      "alpha-queue/AlphaChan/99.json",
    )
  })

  it("rejects path escape on enqueue", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-tg-alpha-"))
    const pump = createTelegramAlphaPump({
      paths: {
        agentRoot: join(root, "agent"),
        archiveRoot: join(root, "archive"),
      },
      runPass: async () => ({ runId: "none", exitCode: 0 }),
    })
    expect(() => pump.enqueue("alpha-queue/../etc/passwd")).toThrow(/escapes/u)
  })
})

describe("createTelegramAlphaPump", () => {
  it("batches paths, dedupes pending, and retries on lock exit 3", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-tg-alpha-"))
    const paths = {
      agentRoot: join(root, "agent"),
      archiveRoot: join(root, "archive"),
    }
    mkdirSync(join(paths.agentRoot, "alpha-queue"), { recursive: true })

    const calls: string[][] = []
    let lockOnce = true
    const runPass = vi.fn(async (args: Readonly<{
      paths: typeof paths
      queuePaths: readonly string[]
    }>) => {
      calls.push([...args.queuePaths])
      if (lockOnce) {
        lockOnce = false
        return { runId: "none", exitCode: 3 as const }
      }
      return { runId: "telegram-alpha-1", exitCode: 0 as const }
    })

    const pump = createTelegramAlphaPump({
      paths,
      runPass: runPass as never,
      lockRetryMs: 1,
      sleep: async () => undefined,
      batchSize: 8,
    })

    pump.enqueue("alpha-queue/chan/1.json")
    pump.enqueue("alpha-queue/chan/1.json")
    pump.enqueue("alpha-queue/chan/2.json")
    pump.enqueue("alpha-queue/chan/3.json")

    await vi.waitFor(() => {
      expect(calls.length).toBeGreaterThanOrEqual(2)
    }, { timeout: 2_000 })

    expect(calls[0]).toEqual([
      "alpha-queue/chan/1.json",
      "alpha-queue/chan/2.json",
      "alpha-queue/chan/3.json",
    ])
    expect(calls[1]).toEqual([
      "alpha-queue/chan/1.json",
      "alpha-queue/chan/2.json",
      "alpha-queue/chan/3.json",
    ])
    expect(pump.pending()).toBe(0)
  })

  it("respects batchSize when more than batch paths are queued", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-tg-alpha-batch-"))
    const paths = {
      agentRoot: join(root, "agent"),
      archiveRoot: join(root, "archive"),
    }
    const calls: string[][] = []
    const runPass = vi.fn(async (args: Readonly<{
      queuePaths: readonly string[]
    }>) => {
      calls.push([...args.queuePaths])
      return { runId: "telegram-alpha-b", exitCode: 0 as const }
    })
    const pump = createTelegramAlphaPump({
      paths,
      runPass: runPass as never,
      batchSize: 2,
      lockRetryMs: 1,
      sleep: async () => undefined,
    })
    for (let i = 1; i <= 5; i++) {
      pump.enqueue(`alpha-queue/chan/${i}.json`)
    }
    await vi.waitFor(() => {
      expect(runPass.mock.calls.length).toBe(3)
    }, { timeout: 2_000 })
    expect(calls[0]).toEqual(["alpha-queue/chan/1.json", "alpha-queue/chan/2.json"])
    expect(calls[1]).toEqual(["alpha-queue/chan/3.json", "alpha-queue/chan/4.json"])
    expect(calls[2]).toEqual(["alpha-queue/chan/5.json"])
    expect(pump.pending()).toBe(0)
  })
})
