import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createDiscordRestClient,
  DISCORD_RESEARCH_STARTED_EMOJI,
} from "../../src/discord/bot-client.js"

describe("discord bot client reactions", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("PUTs white_check_mark on the request message", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)

    const client = createDiscordRestClient("test-token")
    await client.addReaction({
      channelId: "111",
      messageId: "222",
      emoji: DISCORD_RESEARCH_STARTED_EMOJI,
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const [url, init] = call
    expect(url).toBe(
      `https://discord.com/api/v10/channels/111/messages/222/reactions/${encodeURIComponent("✅")}/@me`,
    )
    expect(init).toMatchObject({
      method: "PUT",
      headers: expect.objectContaining({ Authorization: "Bot test-token" }),
    })
    expect(init).not.toHaveProperty("body")
  })
})
