import { describe, expect, it, beforeEach } from "vitest"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyOperatorReaction } from "../../src/broadcast-feedback/intake.js"
import {
  applyFollowupResult,
  classifyFollowupReply,
  expireStaleFollowups,
  handleFeedbackReply,
  writeFollowupEvidence,
} from "../../src/broadcast-feedback/followup.js"
import { broadcastFeedbackLayout } from "../../src/broadcast-feedback/paths.js"
import {
  currentFeedbackRecords,
  readPendingFollowups,
} from "../../src/broadcast-feedback/store.js"
import type { ResolvedBroadcast } from "../../src/broadcast-feedback/resolve.js"
import type { SessionResult } from "../../src/orchestrator/session.js"
import type { RouterEvent } from "../../src/contracts/schemas.js"

const EVENT_ID = `sha256:${"a".repeat(64)}`
const OPERATOR = "200000000000000002"
const NOW = "2026-08-10T00:00:00.000Z"

const RESOLVED: ResolvedBroadcast = {
  index: {
    messageId: "100000000000000001",
    deliveryId: "del-1",
    eventId: EVENT_ID,
    destinationId: "dest-1",
    partIndex: 0,
    partTotal: 1,
    indexedAt: 1_000,
  },
  event: {
    schema: 1,
    eventId: EVENT_ID,
    occurredAt: NOW,
    runId: "run-1",
    type: "finding.broadcast",
    severity: "notable",
    text: "solana:token is moving",
    refs: [],
    auditClaim: {
      type: "token-upside",
      subject: "solana:token",
      direction: "up",
      horizonHours: 72,
      verificationRule: "token.up.72h",
    },
  } as unknown as RouterEvent,
}

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tc-followup-"))
})

function layout() {
  return broadcastFeedbackLayout(home)
}

async function seedDownReaction() {
  return applyOperatorReaction({
    layout: layout(),
    resolved: RESOLVED,
    operatorUserId: OPERATOR,
    up: false,
    down: true,
    nowIso: NOW,
    followupTtlHours: 72,
  })
}

function fakeSession(text: string) {
  return async (): Promise<SessionResult> => ({
    status: "finished",
    text,
  } as SessionResult)
}

describe("follow-up evidence confinement", () => {
  it("writes the reply as untrusted-external evidence", async () => {
    const seeded = await seedDownReaction()
    const path = writeFollowupEvidence({
      layout: layout(),
      feedbackId: seeded.record.feedbackId,
      replyText: "too much jargon and it came far too late",
      nowIso: NOW,
    })
    const body = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    expect(body["trust"]).toBe("untrusted-external")
    expect(body["reply"]).toContain("jargon")
  })
})

describe("follow-up classifier", () => {
  it("parses strict JSON into bounded tags", async () => {
    const result = await classifyFollowupReply({
      repoRoot: process.cwd(),
      evidencePath: "/tmp/evidence.json",
      model: "test-model",
      runSession: fakeSession('{"schema":1,"tags":["jargon","timing"],"summary":"late and jargon heavy"}'),
    })
    expect(result.ok).toBe(true)
    expect(result.ok && result.result.tags).toEqual(["jargon", "timing"])
  })

  it("rejects an unlisted tag", async () => {
    const result = await classifyFollowupReply({
      repoRoot: process.cwd(),
      evidencePath: "/tmp/evidence.json",
      model: "test-model",
      runSession: fakeSession('{"schema":1,"tags":["vibes"],"summary":"bad"}'),
    })
    expect(result.ok).toBe(false)
  })

  it("rejects free prose", async () => {
    const result = await classifyFollowupReply({
      repoRoot: process.cwd(),
      evidencePath: "/tmp/evidence.json",
      model: "test-model",
      runSession: fakeSession("the operator did not like it"),
    })
    expect(result.ok).toBe(false)
  })
})

describe("follow-up completion", () => {
  it("records tags and clears the pending request", async () => {
    const seeded = await seedDownReaction()
    const applied = await applyFollowupResult({
      layout: layout(),
      feedbackId: seeded.record.feedbackId,
      result: { schema: 1, tags: ["accuracy"], summary: "wrong direction" },
      nowIso: "2026-08-10T01:00:00.000Z",
    })
    expect(applied.ok).toBe(true)
    expect(applied.ok && applied.record.followupStatus).toBe("completed")
    expect(applied.ok && applied.record.tags).toEqual(["accuracy"])
    expect(readPendingFollowups(layout()).pending).toHaveLength(0)
  })

  it("refuses detail for a record with no open request", async () => {
    const applied = await applyFollowupResult({
      layout: layout(),
      feedbackId: "fb-unknown-000000",
      result: { schema: 1, tags: ["tone"], summary: "x" },
      nowIso: NOW,
    })
    expect(applied).toEqual({ ok: false, reason: "unknown-feedback" })
  })
})

describe("follow-up expiry", () => {
  it("expires an open request after 72 hours and keeps the down signal", async () => {
    await seedDownReaction()
    const expired = await expireStaleFollowups({
      layout: layout(),
      nowIso: "2026-08-13T00:00:01.000Z",
    })
    expect(expired).toBe(1)
    const records = currentFeedbackRecords(layout())
    expect(records[0]?.state).toBe("down")
    expect(records[0]?.followupStatus).toBe("expired")
    expect(readPendingFollowups(layout()).pending).toHaveLength(0)
  })

  it("keeps a request open before the limit", async () => {
    await seedDownReaction()
    expect(await expireStaleFollowups({
      layout: layout(),
      nowIso: "2026-08-12T00:00:00.000Z",
    })).toBe(0)
  })
})

describe("telegram reply path", () => {
  it("turns natural language into bounded tags", async () => {
    await seedDownReaction()
    const reply = await handleFeedbackReply({
      text: "way too wordy and the tone was off",
      repoRoot: process.cwd(),
      model: "test-model",
      nowIso: "2026-08-10T01:00:00.000Z",
      layout: layout(),
      runSession: fakeSession('{"schema":1,"tags":["too-long","tone"],"summary":"wordy and off tone"}'),
    })
    expect(reply).toBe("Feedback recorded: too-long, tone.")
    expect(currentFeedbackRecords(layout())[0]?.tags).toEqual(["too-long", "tone"])
  })

  it("returns null when no request is open", async () => {
    const reply = await handleFeedbackReply({
      text: "what is the watchlist doing",
      repoRoot: process.cwd(),
      model: "test-model",
      nowIso: NOW,
      layout: layout(),
      runSession: fakeSession('{"schema":1,"tags":["tone"],"summary":"x"}'),
    })
    expect(reply).toBeNull()
  })

  it("keeps the request open after a failed classification", async () => {
    await seedDownReaction()
    const reply = await handleFeedbackReply({
      text: "nonsense",
      repoRoot: process.cwd(),
      model: "test-model",
      nowIso: "2026-08-10T01:00:00.000Z",
      layout: layout(),
      runSession: fakeSession("not json"),
    })
    expect(reply).toContain("could not read")
    expect(readPendingFollowups(layout()).pending).toHaveLength(1)
  })

  it("asks for a direct reply when several requests are open", async () => {
    await seedDownReaction()
    await applyOperatorReaction({
      layout: layout(),
      resolved: {
        ...RESOLVED,
        index: { ...RESOLVED.index, messageId: "100000000000000002" },
        event: { ...RESOLVED.event, eventId: `sha256:${"b".repeat(64)}` } as RouterEvent,
      },
      operatorUserId: OPERATOR,
      up: false,
      down: true,
      nowIso: NOW,
      followupTtlHours: 72,
    })
    const reply = await handleFeedbackReply({
      text: "the second one was wrong",
      repoRoot: process.cwd(),
      model: "test-model",
      nowIso: "2026-08-10T01:00:00.000Z",
      layout: layout(),
      runSession: fakeSession('{"schema":1,"tags":["accuracy"],"summary":"x"}'),
    })
    expect(reply).toContain("Reply directly")
  })
})
