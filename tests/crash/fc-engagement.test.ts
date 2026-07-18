import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/lib/state.js"
import type { FcEngagementFile } from "../../src/contracts/schemas.js"

describe("fc-engagement crash safety", () => {
  it("round-trips engagement state atomically", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-fc-eng-"))
    const stateDir = join(root, "state")
    mkdirSync(stateDir, { recursive: true })
    const store = new StateStore(stateDir)
    const file: FcEngagementFile = {
      schema: 1,
      likedCastHashes: ["0x1111111111111111111111111111111111111111"],
      lastLikedAt: { "0x1111111111111111111111111111111111111111": "2026-07-17T00:00:00.000Z" },
      pendingActionIds: ["sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      decisions: [],
      receipts: [],
      daily: { day: "2026-07-17", likes: 1 },
    }
    await store.saveFcEngagement(file)
    expect(existsSync(store.fcEngagementPath())).toBe(true)
    const loaded = store.loadFcEngagement()
    expect(loaded.likedCastHashes).toEqual(file.likedCastHashes)
    expect(loaded.pendingActionIds).toHaveLength(1)

    // Simulate crash mid-write: corrupt temp should not replace good file when using atomic write again
    writeFileSync(join(stateDir, "fc-engagement.json.tmp"), "{broken")
    await store.saveFcEngagement({
      ...loaded,
      likedCastHashes: [
        ...loaded.likedCastHashes,
        "0x2222222222222222222222222222222222222222",
      ],
    })
    const again = JSON.parse(readFileSync(store.fcEngagementPath(), "utf8")) as FcEngagementFile
    expect(again.likedCastHashes).toHaveLength(2)
  })
})
