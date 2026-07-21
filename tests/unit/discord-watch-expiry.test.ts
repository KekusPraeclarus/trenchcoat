import { describe, expect, it, vi } from "vitest"
import {
  applyWatchExpiryNoticeSent,
  applyWatchExpiryReply,
  classifyWatchExpiryReply,
  planWatchExpiryNotices,
  pruneExpiredWatchlist,
  renderWatchExpiryNotice,
  retainSubscription,
} from "../../src/discord/watchlist.js"
import type { DiscordWatchlistFile } from "../../src/discord/schemas.js"

vi.mock("../../src/lib/config.js", () => ({
  loadConfig: () => ({
    chat: {
      discord: {
        enabled: true,
        watch_days: 30,
        watch_expiry_reply_window_days: 7,
        max_watched_tokens: 500,
        max_subscribers_per_token: 100,
      },
    },
  }),
}))

const WINDOW_MS = 7 * 86_400_000

function baseFile(nowIso: string): DiscordWatchlistFile {
  return {
    schema: 1,
    tokens: [
      {
        chain: "solana",
        tokenAddress: "CREDBH1234567890123456789012345678901234",
        symbolDisplay: "CRED",
        subscriptions: [
          {
            guildId: "1000000000000000001",
            userId: "1000000000000000004",
            channelId: "1000000000000000002",
            messageId: "1000000000000000003",
            startedAt: nowIso,
            renewedAt: nowIso,
            expiresAt: "2026-07-20T00:00:00.000Z",
          },
        ],
      },
      {
        chain: "solana",
        tokenAddress: "WALLET12345678901234567890123456789012345",
        symbolDisplay: "WALLET",
        subscriptions: [
          {
            guildId: "1000000000000000001",
            userId: "1000000000000000004",
            channelId: "1000000000000000002",
            messageId: "1000000000000000005",
            startedAt: nowIso,
            renewedAt: nowIso,
            expiresAt: "2026-07-19T00:00:00.000Z",
          },
        ],
      },
    ],
  }
}

describe("discord watch expiry", () => {
  const nowIso = "2026-07-21T12:00:00.000Z"

  it("plans one bundled notice per user+channel", () => {
    const plans = planWatchExpiryNotices({ file: baseFile(nowIso), nowIso, replyWindowMs: WINDOW_MS })
    expect(plans).toHaveLength(1)
    expect(plans[0]!.labels).toEqual(["CRED", "WALLET"])
    expect(plans[0]!.userId).toBe("1000000000000000004")
  })

  it("retains expired-awaiting-reply and drops lapsed", () => {
    const noticeAt = "2026-07-10T12:00:00.000Z"
    const awaiting = {
      ...baseFile(nowIso).tokens[0]!.subscriptions[0]!,
      expiryNoticeMessageId: "2000000000000000099",
      expiryNoticeAt: noticeAt,
    }
    expect(retainSubscription(awaiting, "2026-07-12T12:00:00.000Z", WINDOW_MS)).toBe(true)
    expect(retainSubscription(awaiting, "2026-07-20T12:00:00.000Z", WINDOW_MS)).toBe(false)

    const neverSent = {
      ...baseFile(nowIso).tokens[0]!.subscriptions[0]!,
      expiresAt: "2026-06-01T00:00:00.000Z",
    }
    expect(retainSubscription(neverSent, nowIso, WINDOW_MS)).toBe(false)
  })

  it("prune keeps awaiting-reply and drops lapsed", () => {
    const file: DiscordWatchlistFile = {
      schema: 1,
      tokens: [
        {
          chain: "solana",
          tokenAddress: "CREDBH1234567890123456789012345678901234",
          symbolDisplay: "CRED",
          subscriptions: [
            {
              guildId: "1000000000000000001",
              userId: "1000000000000000004",
              channelId: "1000000000000000002",
              messageId: "1000000000000000003",
              startedAt: nowIso,
              renewedAt: nowIso,
              expiresAt: "2026-06-01T00:00:00.000Z",
              expiryNoticeMessageId: "2000000000000000099",
              expiryNoticeAt: "2026-07-20T12:00:00.000Z",
            },
          ],
        },
        {
          chain: "solana",
          tokenAddress: "LAPSED1234567890123456789012345678901234",
          symbolDisplay: "OLD",
          subscriptions: [
            {
              guildId: "1000000000000000001",
              userId: "1000000000000000004",
              channelId: "1000000000000000002",
              messageId: "1000000000000000006",
              startedAt: nowIso,
              renewedAt: nowIso,
              expiresAt: "2026-05-01T00:00:00.000Z",
              expiryNoticeMessageId: "2000000000000000098",
              expiryNoticeAt: "2026-06-01T12:00:00.000Z",
            },
          ],
        },
      ],
    }
    const pruned = pruneExpiredWatchlist(file, nowIso, WINDOW_MS)
    expect(pruned.tokens).toHaveLength(1)
    expect(pruned.tokens[0]!.symbolDisplay).toBe("CRED")
  })

  it("records notice ids and renews/clears on yes", () => {
    const file = baseFile(nowIso)
    const plan = planWatchExpiryNotices({ file, nowIso, replyWindowMs: WINDOW_MS })[0]!
    const withNotice = applyWatchExpiryNoticeSent({
      file,
      plan,
      noticeMessageId: "2000000000000000099",
      nowIso,
    })
    expect(
      withNotice.tokens.every((t) => (
        t.subscriptions[0]?.expiryNoticeMessageId === "2000000000000000099"
      )),
    ).toBe(true)

    const renewed = applyWatchExpiryReply({
      file: withNotice,
      noticeMessageId: "2000000000000000099",
      userId: "1000000000000000004",
      decision: "yes",
      nowIso,
    })
    expect(renewed.ok).toBe(true)
    if (!renewed.ok) return
    expect(renewed.renewed).toBe(2)
    expect(renewed.file.tokens.every((t) => (
      Date.parse(t.subscriptions[0]!.expiresAt) > Date.parse(nowIso)
      && t.subscriptions[0]!.expiryNoticeMessageId === undefined
    ))).toBe(true)
  })

  it("removes on no and ignores wrong user", () => {
    const file = baseFile(nowIso)
    const plan = planWatchExpiryNotices({ file, nowIso, replyWindowMs: WINDOW_MS })[0]!
    const withNotice = applyWatchExpiryNoticeSent({
      file,
      plan,
      noticeMessageId: "2000000000000000099",
      nowIso,
    })
    const wrong = applyWatchExpiryReply({
      file: withNotice,
      noticeMessageId: "2000000000000000099",
      userId: "1000000000000000099",
      decision: "yes",
      nowIso,
    })
    expect(wrong.ok).toBe(false)

    const declined = applyWatchExpiryReply({
      file: withNotice,
      noticeMessageId: "2000000000000000099",
      userId: "1000000000000000004",
      decision: "no",
      nowIso,
    })
    expect(declined.ok).toBe(true)
    if (!declined.ok) return
    expect(declined.removed).toBe(2)
    expect(declined.file.tokens).toHaveLength(0)
  })

  it("classifies yes/no and renders notice", () => {
    expect(classifyWatchExpiryReply("yes please")).toBe("yes")
    expect(classifyWatchExpiryReply("keep watching")).toBe("yes")
    expect(classifyWatchExpiryReply("nope")).toBe("no")
    expect(classifyWatchExpiryReply("maybe later")).toBe("other")
    const text = renderWatchExpiryNotice({
      userId: "1000000000000000004",
      labels: ["CRED", "WALLET"],
    })
    expect(text).toContain("<@1000000000000000004>")
    expect(text).toContain("CRED, WALLET")
    expect(text).toContain("yes/no")
  })
})
