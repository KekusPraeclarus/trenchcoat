import { describe, expect, it } from "vitest"
import {
  activeRequestForUser,
  consumeQuota,
  countActiveForUser,
  quotaAllows,
} from "../../src/discord/quota.js"
import { emptyRequestsFile } from "../../src/discord/store.js"

const cfg = {
  chat: {
    discord: {
      per_user_daily_cap: 5,
      server_daily_cap: 20,
      max_active_per_user: 5,
    },
  },
} as never

describe("discord quota", () => {
  it("rolls over on UTC day change", () => {
    const file = emptyRequestsFile("2026-07-18T12:00:00.000Z")
    const spent = consumeQuota(file, "user1", "2026-07-18T12:00:00.000Z")
    expect(spent.dailyServer).toBe(1)
    const nextDay = consumeQuota(spent, "user1", "2026-07-19T00:00:01.000Z")
    expect(nextDay.dailyServer).toBe(1)
    expect(nextDay.dailyByUser["user1"]).toBe(1)
  })

  it("blocks when user cap reached", () => {
    let file = emptyRequestsFile("2026-07-19T12:00:00.000Z")
    for (let i = 0; i < 5; i += 1) {
      file = consumeQuota(file, "user1", "2026-07-19T12:00:00.000Z")
    }
    const check = quotaAllows(file, "user1", cfg, "2026-07-19T12:00:00.000Z")
    expect(check.ok).toBe(false)
  })

  it("counts queued and running toward queue depth", () => {
    const file = emptyRequestsFile("2026-07-19T12:00:00.000Z")
    file.requests.push(
      {
        requestId: "1",
        guildId: "100",
        channelId: "200",
        messageId: "1",
        userId: "u1",
        subject: "solana:abc",
        status: "queued",
        createdAt: "2026-07-19T12:00:00.000Z",
        updatedAt: "2026-07-19T12:00:00.000Z",
        quotaDay: "2026-07-19",
        deliveredPartKeys: [],
      },
      {
        requestId: "2",
        guildId: "100",
        channelId: "200",
        messageId: "2",
        userId: "u1",
        subject: "solana:def",
        status: "running",
        createdAt: "2026-07-19T12:01:00.000Z",
        updatedAt: "2026-07-19T12:01:00.000Z",
        quotaDay: "2026-07-19",
        deliveredPartKeys: [],
      },
      {
        requestId: "3",
        guildId: "100",
        channelId: "200",
        messageId: "3",
        userId: "u2",
        subject: "solana:ghi",
        status: "queued",
        createdAt: "2026-07-19T12:02:00.000Z",
        updatedAt: "2026-07-19T12:02:00.000Z",
        quotaDay: "2026-07-19",
        deliveredPartKeys: [],
      },
    )
    expect(activeRequestForUser(file, "u1")?.status).toBe("queued")
    expect(countActiveForUser(file, "u1")).toBe(2)
    expect(countActiveForUser(file, "u2")).toBe(1)
  })
})
