import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  acceptChannelMessage,
  cursorsPath,
  loadChannelCursors,
  pollPreviewChannel,
} from "../../src/collectors/telegram/channels.js"
import { floodWaitMilliseconds } from "../../src/collectors/telegram/collector.js"
import type { FetchLike } from "../../src/collectors/market/geckoterminal.js"

const PREVIEW_HTML = `
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="alpha/42"><div class="tgme_widget_message_text">hello alpha</div><time datetime="2026-07-18T12:00:00+00:00"></time></div></div>
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="alpha/43"><div class="tgme_widget_message_text">second msg</div><time datetime="2026-07-18T12:01:00+00:00"></time></div></div>
`

describe("telegram channel cursors", () => {
  it("checkpoints every accepted message and skips duplicates on re-poll", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tc-tg-chan-")))
    const agentRoot = join(root, "agent")
    const home = join(root, "home")
    mkdirSync(agentRoot, { recursive: true })
    const cursorFile = cursorsPath(home)

    const first = await acceptChannelMessage({
      agentRoot,
      cursorsFilePath: cursorFile,
      nowIso: "2026-07-18T12:00:00.000Z",
      message: {
        id: "42",
        channel: "alpha",
        text: "hello",
        timestamp: "2026-07-18T12:00:00.000Z",
        url: "https://t.me/alpha/42",
        provenance: "telegram:alpha",
      },
    })
    expect(first.written).toBe(true)
    expect(first.cursorAdvanced).toBe(true)
    expect(loadChannelCursors(cursorFile).channels["alpha"]?.lastId).toBe("42")
    expect(existsSync(join(agentRoot, "alpha-queue", "alpha", "42.json"))).toBe(true)

    const again = await acceptChannelMessage({
      agentRoot,
      cursorsFilePath: cursorFile,
      nowIso: "2026-07-18T12:01:00.000Z",
      message: {
        id: "42",
        channel: "alpha",
        text: "hello",
        timestamp: "2026-07-18T12:00:00.000Z",
        url: "https://t.me/alpha/42",
        provenance: "telegram:alpha",
      },
    })
    expect(again.written).toBe(false)
    expect(again.cursorAdvanced).toBe(true)
  })

  it("pollPreviewChannel advances past lastId", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tc-tg-poll-")))
    const agentRoot = join(root, "agent")
    const home = join(root, "home")
    mkdirSync(agentRoot, { recursive: true })
    const cursorFile = cursorsPath(home)
    const fetcher: FetchLike = async () => new Response(PREVIEW_HTML, { status: 200 })

    const first = await pollPreviewChannel({
      agentRoot,
      channel: "alpha",
      fetcher,
      cursorsFilePath: cursorFile,
      nowIso: "2026-07-18T12:00:00.000Z",
    })
    expect(first.accepted).toBe(2)
    expect(first.newestId).toBe("43")
    expect(readFileSync(join(agentRoot, "alpha-queue", "alpha", "43.json"), "utf8")).toContain("second msg")

    const second = await pollPreviewChannel({
      agentRoot,
      channel: "alpha",
      fetcher,
      cursorsFilePath: cursorFile,
      nowIso: "2026-07-18T12:02:00.000Z",
    })
    expect(second.accepted).toBe(0)
  })

  it("parses FLOOD_WAIT delays", () => {
    expect(floodWaitMilliseconds({ seconds: 3 })).toBe(3_000)
    expect(floodWaitMilliseconds({ errorMessage: "FLOOD_WAIT_12" })).toBe(12_000)
    expect(floodWaitMilliseconds(new Error("nope"))).toBeUndefined()
  })
})
