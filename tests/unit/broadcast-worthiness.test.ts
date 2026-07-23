import { describe, expect, it, vi } from "vitest"
import {
  claimHash,
  runBroadcastWorthiness,
  validateWorthinessOutput,
  worthinessUserMessage,
} from "../../src/orchestrator/broadcast-worthiness.js"
import type { BroadcastItem } from "../../src/contracts/schemas.js"
import { BROADCAST_WORTHINESS_PROMPT } from "../../src/prompts/host.js"

const ITEM: BroadcastItem = {
  severity: "watch",
  text: "RH rotation just flipped to peaking on fresh X + TG corroboration",
  refs: ["state/narratives/example.md"],
  auditClaim: {
    type: "narrative-emergence",
    subject: "rh-chain-meme-rotation",
    direction: "up",
    horizonHours: 72,
    verificationRule: "narrative.emergence",
  },
}

describe("validateWorthinessOutput", () => {
  it("approves founder primary-source catalysts in the host prompt", () => {
    expect(BROADCAST_WORTHINESS_PROMPT).toMatch(/founder \/ protocol primary-source catalyst/i)
    expect(BROADCAST_WORTHINESS_PROMPT).toMatch(/Never reject a first-time founder primary-source catalyst/i)
    expect(BROADCAST_WORTHINESS_PROMPT).toMatch(/Judge from auditClaim, refs, severity/i)
    expect(BROADCAST_WORTHINESS_PROMPT).not.toMatch(/agentNotes/)
    expect(BROADCAST_WORTHINESS_PROMPT).not.toMatch(/proposal text is untrusted/)
  })

  it("accepts worth true/false with a reason", () => {
    expect(validateWorthinessOutput('{"worth":true,"reason":"new heat"}')).toEqual({
      ok: true,
      worth: true,
      reason: "new heat",
    })
    expect(validateWorthinessOutput('{"worth":false,"reason":"status quo"}')).toEqual({
      ok: true,
      worth: false,
      reason: "status quo",
    })
  })

  it("strips markdown fences", () => {
    expect(validateWorthinessOutput('```json\n{"worth":true,"reason":"ok"}\n```')).toEqual({
      ok: true,
      worth: true,
      reason: "ok",
    })
  })

  it("rejects malformed payloads", () => {
    expect(validateWorthinessOutput("").ok).toBe(false)
    expect(validateWorthinessOutput("not-json").reason).toBe("invalid-json")
    expect(validateWorthinessOutput("[]").reason).toBe("not-object")
    expect(validateWorthinessOutput('{"worth":"yes","reason":"x"}').reason).toBe("worth-not-boolean")
    expect(validateWorthinessOutput('{"worth":true,"reason":1}').reason).toBe("reason-not-string")
    expect(validateWorthinessOutput('{"worth":true,"reason":"   "}').reason).toBe("reason-empty")
  })

  it("clips long reasons", () => {
    const long = "x".repeat(300)
    const result = validateWorthinessOutput(JSON.stringify({ worth: false, reason: long }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.reason).toHaveLength(200)
  })
})

describe("claimHash", () => {
  it("hashes auditClaim fields only", () => {
    const hash = claimHash(ITEM.auditClaim)
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(claimHash({ ...ITEM.auditClaim, subject: " RH-CHAIN-MEME-ROTATION " })).toBe(hash)
  })
})

describe("worthinessUserMessage", () => {
  it("lists trusted claim context without proposal text or agent notes", () => {
    const message = worthinessUserMessage({
      item: ITEM,
      context: {
        job: "telegram-alpha",
        collectionStatus: "alpha-pending:1",
        marketBlind: false,
        statusQuoStages: [{ slug: "rh-chain-meme-rotation", title: "RH Chain", stage: "peaking" }],
        recentBroadcasts: [{
          occurredAt: "2026-07-21T10:00:00.000Z",
          subject: "rh-chain-meme-rotation",
          summary: "PONS founder follow moved the token toward $40M",
          destinations: ["telegram", "discord"],
        }],
      },
    })
    expect(message).toContain("job: telegram-alpha")
    expect(message).toContain("from claim, refs, and history only")
    expect(message).toContain("verificationRule=narrative.emergence")
    expect(message).toContain("horizonHours=72")
    expect(message).toContain("statusQuoStages:")
    expect(message).toContain("<accepted-broadcast-history>")
    expect(message).toContain("<staged-broadcast-history>")
    expect(message).toContain("PONS founder follow")
    expect(message).not.toContain("<untrusted-proposal>")
    expect(message).not.toContain(ITEM.text)
    expect(message).not.toContain("agentNotes")
    expect(message).not.toContain("<untrusted-agent-notes>")
  })

  it("labels accepted and staged history separately", () => {
    const message = worthinessUserMessage({
      item: ITEM,
      context: {
        job: "list-scan",
        recentBroadcasts: [
          {
            occurredAt: "2026-07-21T10:00:00.000Z",
            subject: "rh-chain-meme-rotation",
            summary: "accepted prior",
            destinations: ["telegram"],
            status: "accepted",
          },
          {
            occurredAt: "2026-07-21T11:00:00.000Z",
            subject: "rh-chain-meme-rotation",
            summary: "staged prior",
            destinations: ["telegram"],
            status: "staged",
          },
        ],
      },
    })
    expect(message).toMatch(/<accepted-broadcast-history>[\s\S]*accepted prior[\s\S]*<\/accepted-broadcast-history>/)
    expect(message).toMatch(/<staged-broadcast-history>[\s\S]*staged prior[\s\S]*<\/staged-broadcast-history>/)
    expect(BROADCAST_WORTHINESS_PROMPT).toMatch(/staged-broadcast-history/)
  })
})

describe("runBroadcastWorthiness", () => {
  it("returns worth true when disabled", async () => {
    const result = await runBroadcastWorthiness({
      item: ITEM,
      enabled: false,
      context: { job: "list-scan" },
    })
    expect(result).toEqual({ ok: true, worth: true, reason: "disabled" })
  })

  it("fail-closes without a runner", async () => {
    const result = await runBroadcastWorthiness({
      item: ITEM,
      enabled: true,
      context: { job: "list-scan" },
    })
    expect(result).toEqual({ ok: false, reason: "no-runner" })
  })

  it("fail-closes on session error", async () => {
    const result = await runBroadcastWorthiness({
      item: ITEM,
      enabled: true,
      context: { job: "list-scan" },
      runSession: async () => {
        throw new Error("boom")
      },
    })
    expect(result).toEqual({ ok: false, reason: "session-error" })
  })

  it("returns parsed worth from the session", async () => {
    const runSession = vi.fn(async () => '{"worth":false,"reason":"thin FYI"}')
    const result = await runBroadcastWorthiness({
      item: ITEM,
      enabled: true,
      context: { job: "list-scan" },
      runSession,
    })
    expect(result).toEqual({ ok: true, worth: false, reason: "thin FYI" })
    expect(runSession).toHaveBeenCalledOnce()
  })
})
