import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import {
  buildHealthSnapshot,
  formatHealthText,
  toHealthJsonPayload,
} from "../../src/orchestrator/health.js"
import { broadcastFeedbackLayout } from "../../src/broadcast-feedback/paths.js"
import { appendFeedbackEvent, writePendingFollowups } from "../../src/broadcast-feedback/store.js"
import type { BroadcastFeedbackRecord } from "../../src/broadcast-feedback/schemas.js"

const NOW = "2026-08-10T12:00:00.000Z"

let home: string
let previousHome: string | undefined
let previousOperator: string | undefined

function writeConfig(feedbackEnabled: boolean): void {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "config/seed.example.json"), "utf8"),
  ) as Record<string, unknown>
  const broadcast = raw["broadcast"] as Record<string, unknown>
  broadcast["feedback"] = {
    ...(broadcast["feedback"] as Record<string, unknown>),
    enabled: feedbackEnabled,
    channel_id: "900000000000000001",
  }
  const chat = raw["chat"] as Record<string, unknown>
  chat["discord"] = {
    ...(chat["discord"] as Record<string, unknown>),
    enabled: true,
    channel_ids: ["900000000000000001"],
  }
  mkdirSync(join(home, ".trenchcoat"), { recursive: true })
  writeFileSync(
    join(home, ".trenchcoat", "config.json"),
    `${JSON.stringify(raw, null, 2)}\n`,
  )
}

function record(overrides: Partial<BroadcastFeedbackRecord>): BroadcastFeedbackRecord {
  return {
    schema: 1,
    feedbackId: "fb-000000001",
    eventId: `sha256:${"a".repeat(64)}`,
    deliveryId: "del-1",
    runId: "run-1",
    providerMessageId: "100000000000000001",
    partIndex: 0,
    partTotal: 1,
    operatorUserId: "200000000000000002",
    state: "up",
    firstReactionAt: "2026-08-09T00:00:00.000Z",
    lastReactionAt: "2026-08-09T00:00:00.000Z",
    followupStatus: "not-required",
    tags: [],
    ...overrides,
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tc-health-fb-"))
  previousHome = process.env["HOME"]
  previousOperator = process.env["DISCORD_OPERATOR_USER_ID"]
  process.env["HOME"] = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env["HOME"]
  else process.env["HOME"] = previousHome
  if (previousOperator === undefined) delete process.env["DISCORD_OPERATOR_USER_ID"]
  else process.env["DISCORD_OPERATOR_USER_ID"] = previousOperator
})

async function snapshot() {
  const root = mkdtempSync(join(tmpdir(), "tc-health-fb-root-"))
  const agentRoot = join(root, "agent")
  const archiveRoot = join(root, "archive")
  mkdirSync(join(agentRoot, "state"), { recursive: true })
  const layout = await ensureArchive(archiveRoot)
  return buildHealthSnapshot({
    agentRoot,
    archiveRoot,
    nowIso: NOW,
    layout,
    farcasterEnabled: false,
    feedbackHome: home,
  })
}

describe("broadcast feedback health", () => {
  it("reports the lane as disabled by default", async () => {
    writeConfig(false)
    const health = await snapshot()
    expect(health.broadcastFeedback.enabled).toBe(false)
    expect(formatHealthText(health)).toContain("feedback: disabled")
    expect(health.findings.some((f) => f.component === "broadcast-feedback")).toBe(false)
  })

  it("counts reactions, detail, and open requests when enabled", async () => {
    writeConfig(true)
    process.env["DISCORD_OPERATOR_USER_ID"] = "200000000000000002"
    const layout = broadcastFeedbackLayout(home)
    mkdirSync(layout.root, { recursive: true })
    appendFeedbackEvent(layout, {
      schema: 1,
      recordedAt: "2026-08-09T00:00:00.000Z",
      transition: "reaction",
      record: record({}),
    })
    appendFeedbackEvent(layout, {
      schema: 1,
      recordedAt: "2026-08-09T01:00:00.000Z",
      transition: "followup-completed",
      record: record({
        feedbackId: "fb-000000002",
        eventId: `sha256:${"b".repeat(64)}`,
        state: "down",
        followupStatus: "completed",
        lastReactionAt: "2026-08-09T01:00:00.000Z",
        tags: ["accuracy"],
      }),
    })
    writePendingFollowups(layout, [{
      feedbackId: "fb-000000003",
      eventId: `sha256:${"c".repeat(64)}`,
      state: "down",
      requestedAt: "2026-08-09T02:00:00.000Z",
      expiresAt: "2026-08-12T02:00:00.000Z",
    }])

    const health = await snapshot()
    expect(health.broadcastFeedback).toMatchObject({
      enabled: true,
      operatorSet: true,
      records: 2,
      up: 1,
      completedDown: 1,
      pendingFollowups: 1,
      staleFollowups: 0,
    })
    expect(health.broadcastFeedback.lastFeedbackAt).toBe("2026-08-09T01:00:00.000Z")
    const text = formatHealthText(health)
    expect(text).toContain("feedback: up=1 downDetail=1 pending=1")
    expect(toHealthJsonPayload(health)["broadcastFeedback"]).toMatchObject({ up: 1 })
  })

  it("finds a follow-up past the 72 hour limit", async () => {
    writeConfig(true)
    process.env["DISCORD_OPERATOR_USER_ID"] = "200000000000000002"
    const layout = broadcastFeedbackLayout(home)
    mkdirSync(layout.root, { recursive: true })
    writePendingFollowups(layout, [{
      feedbackId: "fb-000000004",
      eventId: `sha256:${"d".repeat(64)}`,
      state: "down",
      requestedAt: "2026-08-05T00:00:00.000Z",
      expiresAt: "2026-08-08T00:00:00.000Z",
    }])
    const health = await snapshot()
    expect(health.broadcastFeedback.staleFollowups).toBe(1)
    expect(health.findings.some((f) => f.code === "feedback-followup-stale")).toBe(true)
  })

  it("warns when the operator id is unset", async () => {
    writeConfig(true)
    delete process.env["DISCORD_OPERATOR_USER_ID"]
    const health = await snapshot()
    expect(health.broadcastFeedback.operatorSet).toBe(false)
    expect(health.findings.some((f) => f.code === "feedback-operator-unset")).toBe(true)
    expect(formatHealthText(health)).toContain("OPERATOR-UNSET")
  })
})
