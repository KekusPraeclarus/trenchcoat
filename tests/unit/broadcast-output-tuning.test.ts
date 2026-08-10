import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  copyGuidanceBlock,
  loadBroadcastOutputTuning,
  withGuidance,
  worthinessGuidanceBlock,
} from "../../src/orchestrator/broadcast-output-tuning.js"
import { worthinessUserMessage } from "../../src/orchestrator/broadcast-worthiness.js"

function tuningRoot(
  copyGuidance: readonly string[],
  worthinessGuidance: readonly string[] = [],
): string {
  const root = mkdtempSync(join(tmpdir(), "tc-tuning-"))
  mkdirSync(join(root, "config"), { recursive: true })
  writeFileSync(
    join(root, "config/broadcast-output-tuning.json"),
    JSON.stringify({
      schema: 1,
      updatedAt: "2026-08-10T00:00:00.000Z",
      copyGuidance,
      worthinessGuidance,
    }),
  )
  return root
}

describe("broadcast output tuning", () => {
  it("loads operator guidance from the repository file", () => {
    const root = tuningRoot(["name the sector"], ["skip repeat calls"])
    const tuning = loadBroadcastOutputTuning(root)
    expect(tuning.copyGuidance).toEqual(["name the sector"])
    expect(tuning.worthinessGuidance).toEqual(["skip repeat calls"])
  })

  it("returns empty guidance when the file is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-tuning-none-"))
    expect(loadBroadcastOutputTuning(root).copyGuidance).toEqual([])
  })

  it("returns empty guidance when the file is unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-tuning-bad-"))
    mkdirSync(join(root, "config"), { recursive: true })
    writeFileSync(join(root, "config/broadcast-output-tuning.json"), "{ not json")
    expect(loadBroadcastOutputTuning(root).copyGuidance).toEqual([])
  })

  it("adds nothing to a prompt when guidance is empty", () => {
    expect(withGuidance("BASE", copyGuidanceBlock({
      schema: 1,
      updatedAt: "2026-08-10T00:00:00.000Z",
      copyGuidance: [],
      worthinessGuidance: [],
    }))).toBe("BASE")
  })

  it("adds a bounded guidance block to a prompt", () => {
    const block = copyGuidanceBlock({
      schema: 1,
      updatedAt: "2026-08-10T00:00:00.000Z",
      copyGuidance: ["name the sector"],
      worthinessGuidance: [],
    })
    const prompt = withGuidance("BASE", block)
    expect(prompt).toContain("BASE")
    expect(prompt).toContain("name the sector")
  })

  it("names worthiness guidance in its own block", () => {
    expect(worthinessGuidanceBlock({
      schema: 1,
      updatedAt: "2026-08-10T00:00:00.000Z",
      copyGuidance: ["copy only"],
      worthinessGuidance: ["skip repeat calls"],
    })).toContain("skip repeat calls")
  })

  it("puts worthiness guidance into the worthiness message", () => {
    const message = worthinessUserMessage({
      item: {
        severity: "notable",
        text: "s",
        refs: [],
        auditClaim: {
          type: "token-upside",
          subject: "solana:token",
          direction: "up",
          horizonHours: 72,
          verificationRule: "token.up.72h",
        },
      },
      context: { job: "watchlist-scan" },
      guidance: ["skip repeat calls"],
    })
    expect(message).toContain("skip repeat calls")
  })
})
