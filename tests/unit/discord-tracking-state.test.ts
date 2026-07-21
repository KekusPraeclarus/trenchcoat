import { describe, expect, it } from "vitest"
import {
  parseTrackingIntentOutput,
  isTrackingGateOpen,
} from "../../src/discord/tracking-intent.js"
import {
  applyTrackAction,
  applyDropAction,
  applyExtendAction,
  countActiveForUser,
  planExpiryNotices,
  applyExpiryNoticeSent,
  flipElapsedAwaitingReply,
  pruneTrackingFile,
  activeMatchableRequests,
  type TrackingConfigSlice,
} from "../../src/discord/tracking-state.js"
import { emptyTrackingFile } from "../../src/discord/store.js"
import { addDaysIso, addHoursIso, isWithinHours, isExpiredAt } from "../../src/discord/tracking-ids.js"
import {
  sanitizeTrackingReason,
  renderExpiryNotice,
  renderCapacityMessage,
  renderTrackingPing,
} from "../../src/discord/tracking-sanitize.js"
import { parseTrackingMatchOutput } from "../../src/discord/tracking-match.js"

const CFG: TrackingConfigSlice = {
  max_active_per_user: 10,
  ttl_days: 30,
  expiry_bundle_hours: 48,
  pending_capacity_ttl_hours: 48,
  tentative_confirm_window_hours: 24,
  expiry_reply_window_days: 7,
  retention_days: 35,
}

const NOW = "2026-07-21T12:00:00.000Z"
const GUILD = "1000000000000000001"
const CHANNEL = "1000000000000000002"
const USER = "1000000000000000004"

describe("tracking intent parse", () => {
  it("parses strict JSON actions", () => {
    expect(parseTrackingIntentOutput(JSON.stringify({
      action: "track",
      description: "privacy on RH",
      shortLabel: "Privacy on RH",
      confidence: "high",
    }) )?.action).toBe("track")
    expect(parseTrackingIntentOutput('{"action":"none"}')?.action).toBe("none")
  })

  it("fail-closes on prose, fences, trailing JSON, unknown actions", () => {
    expect(parseTrackingIntentOutput("track this")).toBeUndefined()
    expect(parseTrackingIntentOutput("```json\n{\"action\":\"none\"}\n```")).toBeUndefined()
    expect(parseTrackingIntentOutput('{"action":"none"} trailing')).toBeUndefined()
    expect(parseTrackingIntentOutput('{"action":"explode"}')).toBeUndefined()
  })

  it("gates on mention or reply-to-bot only", () => {
    expect(isTrackingGateOpen({ mentionsBot: true, replyToBot: false })).toBe(true)
    expect(isTrackingGateOpen({ mentionsBot: false, replyToBot: true })).toBe(true)
    expect(isTrackingGateOpen({ mentionsBot: false, replyToBot: false })).toBe(false)
  })
})

describe("tracking state transitions", () => {
  it("activates high-confidence track under the cap", () => {
    const result = applyTrackAction({
      file: emptyTrackingFile(),
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: "1000000000000000010",
      userId: USER,
      description: "privacy mixer on RH",
      shortLabel: "Privacy on RH",
      confidence: "high",
      nowIso: NOW,
      config: CFG,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.kind).toBe("active")
    expect(result.reactMessageIds).toEqual(["1000000000000000010"])
    expect(countActiveForUser(result.file, GUILD, USER, NOW)).toBe(1)
  })

  it("stores low-confidence as tentative without reaction", () => {
    const result = applyTrackAction({
      file: emptyTrackingFile(),
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: "1000000000000000011",
      userId: USER,
      description: "maybe privacy stuff",
      shortLabel: "Maybe privacy",
      confidence: "low",
      nowIso: NOW,
      config: CFG,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.kind).toBe("tentative")
    expect(result.reactMessageIds).toEqual([])
  })

  it("enforces 10-active cap with pending-capacity", () => {
    let file = emptyTrackingFile()
    for (let i = 0; i < 10; i += 1) {
      const applied = applyTrackAction({
        file,
        guildId: GUILD,
        channelId: CHANNEL,
        messageId: `10000000000000001${String(i).padStart(2, "0")}`,
        userId: USER,
        description: `desc ${i}`,
        shortLabel: `Label ${i}`,
        confidence: "high",
        nowIso: NOW,
        config: CFG,
      })
      expect(applied.ok).toBe(true)
      if (!applied.ok) return
      file = applied.file
    }
    expect(countActiveForUser(file, GUILD, USER, NOW)).toBe(10)
    const pending = applyTrackAction({
      file,
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: "1000000000000000199",
      userId: USER,
      description: "one more",
      shortLabel: "One more",
      confidence: "high",
      nowIso: NOW,
      config: CFG,
    })
    expect(pending.ok).toBe(true)
    if (!pending.ok) return
    expect(pending.kind).toBe("pending-capacity")
    expect(pending.reply).toContain("limit of 10")
    expect(countActiveForUser(pending.file, GUILD, USER, NOW)).toBe(10)
  })

  it("drop activates newest pending-capacity and reacts to both", () => {
    let file = emptyTrackingFile()
    for (let i = 0; i < 10; i += 1) {
      const applied = applyTrackAction({
        file,
        guildId: GUILD,
        channelId: CHANNEL,
        messageId: `10000000000000002${String(i).padStart(2, "0")}`,
        userId: USER,
        description: `desc ${i}`,
        shortLabel: `Label ${i}`,
        confidence: "high",
        nowIso: NOW,
        config: CFG,
      })
      if (!applied.ok) throw new Error("setup")
      file = applied.file
    }
    const pending = applyTrackAction({
      file,
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: "1000000000000000299",
      userId: USER,
      description: "pending one",
      shortLabel: "Pending",
      confidence: "high",
      nowIso: NOW,
      config: CFG,
    })
    if (!pending.ok) throw new Error("pending")
    file = pending.file
    const dropId = file.requests.find((r) => r.status === "active")!.trackingId
    const dropped = applyDropAction({
      file,
      guildId: GUILD,
      userId: USER,
      trackingIds: [dropId],
      triggerMessageId: "1000000000000000300",
      nowIso: NOW,
      config: CFG,
    })
    expect(dropped.ok).toBe(true)
    if (!dropped.ok) return
    expect(dropped.activated?.shortLabel).toBe("Pending")
    expect(dropped.reactMessageIds).toContain("1000000000000000300")
    expect(dropped.reactMessageIds).toContain("1000000000000000299")
    expect(countActiveForUser(dropped.file, GUILD, USER, NOW)).toBe(10)
  })

  it("rejects cross-owner drop", () => {
    const tracked = applyTrackAction({
      file: emptyTrackingFile(),
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: "1000000000000000400",
      userId: USER,
      description: "x",
      shortLabel: "X",
      confidence: "high",
      nowIso: NOW,
      config: CFG,
    })
    if (!tracked.ok) throw new Error("track")
    const result = applyDropAction({
      file: tracked.file,
      guildId: GUILD,
      userId: "1000000000000000999",
      trackingIds: [tracked.request.trackingId],
      triggerMessageId: "1000000000000000401",
      nowIso: NOW,
      config: CFG,
    })
    expect(result.ok).toBe(false)
  })

  it("confirms tentative within window", () => {
    const tentative = applyTrackAction({
      file: emptyTrackingFile(),
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: "1000000000000000500",
      userId: USER,
      description: "ai sol",
      shortLabel: "Sol AI",
      confidence: "low",
      nowIso: NOW,
      config: CFG,
    })
    if (!tentative.ok) throw new Error("tentative")
    const confirmed = applyTrackAction({
      file: tentative.file,
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: "1000000000000000501",
      userId: USER,
      description: "ai sol",
      shortLabel: "Sol AI",
      confidence: "high",
      nowIso: addHoursIso(NOW, 1),
      config: CFG,
      confirmTentativeId: tentative.request.trackingId,
    })
    expect(confirmed.ok).toBe(true)
    if (!confirmed.ok) return
    expect(confirmed.kind).toBe("active")
    expect(confirmed.request.status).toBe("active")
  })
})

describe("tracking expiry", () => {
  it("bundles elapsed plus <48h and excludes exact 48h boundary", () => {
    expect(isWithinHours(addHoursIso(NOW, 47.9), NOW, 48)).toBe(true)
    expect(isWithinHours(addHoursIso(NOW, 48), NOW, 48)).toBe(false)
    expect(isExpiredAt(NOW, NOW)).toBe(true)
    expect(isExpiredAt(addHoursIso(NOW, 1), NOW)).toBe(false)
  })

  it("plans one notice per user and keeps future bundled active", () => {
    let file = emptyTrackingFile()
    const elapsed = applyTrackAction({
      file,
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: "1000000000000000600",
      userId: USER,
      description: "a",
      shortLabel: "A",
      confidence: "high",
      nowIso: addDaysIso(NOW, -31),
      config: CFG,
    })
    if (!elapsed.ok) throw new Error("e")
    file = elapsed.file
    // Force expiresAt into the past
    file = {
      ...file,
      requests: file.requests.map((r) => ({
        ...r,
        expiresAt: addHoursIso(NOW, -1),
      })),
    }
    const soon = applyTrackAction({
      file,
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: "1000000000000000601",
      userId: USER,
      description: "b",
      shortLabel: "B",
      confidence: "high",
      nowIso: NOW,
      config: CFG,
    })
    if (!soon.ok) throw new Error("s")
    file = {
      ...soon.file,
      requests: soon.file.requests.map((r) => (
        r.shortLabel === "B"
          ? { ...r, expiresAt: addHoursIso(NOW, 24) }
          : r
      )),
    }
    const plans = planExpiryNotices({ file, nowIso: NOW, config: CFG })
    expect(plans).toHaveLength(1)
    expect(plans[0]!.labels).toEqual(["A", "B"])
    const after = applyExpiryNoticeSent({
      file,
      plan: plans[0]!,
      noticeMessageId: "1000000000000000700",
      nowIso: NOW,
    })
    const a = after.requests.find((r) => r.shortLabel === "A")!
    const b = after.requests.find((r) => r.shortLabel === "B")!
    expect(a.status).toBe("expired-awaiting-reply")
    expect(b.status).toBe("active")
    expect(a.expiryNoticeMessageId).toBe("1000000000000000700")
    expect(b.expiryNoticeMessageId).toBe("1000000000000000700")
    expect(activeMatchableRequests(after, NOW).map((r) => r.shortLabel)).toEqual(["B"])
  })

  it("extend/decline handles bare subsets and cap", () => {
    let file = emptyTrackingFile()
    const a = applyTrackAction({
      file,
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: "1000000000000000800",
      userId: USER,
      description: "a",
      shortLabel: "A",
      confidence: "high",
      nowIso: NOW,
      config: CFG,
    })
    if (!a.ok) throw new Error("a")
    file = {
      ...a.file,
      requests: a.file.requests.map((r) => ({
        ...r,
        status: "expired-awaiting-reply" as const,
        expiresAt: addHoursIso(NOW, -1),
        expiryNoticeMessageId: "1000000000000000801",
      })),
    }
    const extended = applyExtendAction({
      file,
      guildId: GUILD,
      userId: USER,
      extendIds: [file.requests[0]!.trackingId],
      declineIds: [],
      triggerMessageId: "1000000000000000802",
      nowIso: NOW,
      config: CFG,
    })
    expect(extended.ok).toBe(true)
    if (!extended.ok) return
    expect(extended.file.requests[0]!.status).toBe("active")
    expect(extended.file.requests[0]!.extensionCount).toBe(1)
  })

  it("renders expiry copy", () => {
    expect(renderExpiryNotice({ userId: USER, labels: ["Privacy on RH"] }))
      .toContain("has expired")
    expect(renderExpiryNotice({ userId: USER, labels: ["A", "B"] }))
      .toContain("Which do you want to extend?")
    expect(renderCapacityMessage(["A"], 10)).toContain("limit of 10")
    expect(renderTrackingPing(USER, "a mixer")).toBe(`<@${USER}> I see talk of a mixer`)
  })

  it("flips elapsed active to awaiting-reply", () => {
    const tracked = applyTrackAction({
      file: emptyTrackingFile(),
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: "1000000000000000900",
      userId: USER,
      description: "x",
      shortLabel: "X",
      confidence: "high",
      nowIso: NOW,
      config: CFG,
    })
    if (!tracked.ok) throw new Error("t")
    const file = {
      ...tracked.file,
      requests: tracked.file.requests.map((r) => ({
        ...r,
        expiresAt: addHoursIso(NOW, -1),
        expiryNoticeMessageId: "1000000000000000901",
      })),
    }
    const flipped = flipElapsedAwaitingReply({ file, nowIso: NOW })
    expect(flipped.requests[0]!.status).toBe("expired-awaiting-reply")
  })

  it("prunes stale pending-capacity and tentative", () => {
    const pending = applyTrackAction({
      file: emptyTrackingFile(),
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: "1000000000000000910",
      userId: USER,
      description: "x",
      shortLabel: "X",
      confidence: "low",
      nowIso: NOW,
      config: CFG,
    })
    if (!pending.ok) throw new Error("p")
    const pruned = pruneTrackingFile({
      file: pending.file,
      nowIso: addHoursIso(NOW, 25),
      config: CFG,
    })
    expect(pruned.requests[0]!.status).toBe("dropped")
  })
})

describe("tracking match sanitize", () => {
  it("strips mentions and urls from reasons", () => {
    expect(sanitizeTrackingReason("<@123> @everyone https://evil.com hi")).toBe("hi")
    expect(sanitizeTrackingReason("mixer <@&999>")).toBe("mixer")
  })

  it("allowlists match output", () => {
    const allow = new Set(["trk-ok123456"])
    const hits = parseTrackingMatchOutput(JSON.stringify({
      matches: [
        { trackingId: "trk-ok123456", subject: "FOO", reason: "privacy <@1> https://x.com" },
        { trackingId: "trk-evil99999", subject: "BAR", reason: "nope" },
        { trackingId: "trk-ok123456", subject: "FOO", reason: "dup" },
      ],
    }), allow, 10)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.reason).toBe("privacy")
  })

  it("rejects malformed match JSON", () => {
    expect(parseTrackingMatchOutput("not json", new Set(["trk-ok123456"]), 10)).toEqual([])
    expect(parseTrackingMatchOutput('{"matches":[]}\nextra', new Set(["trk-ok123456"]), 10)).toEqual([])
  })
})
