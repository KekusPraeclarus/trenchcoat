import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/lib/state.js"
import { archiveLayout } from "../../src/lib/archive.js"
import { sha256Bytes } from "../../src/lib/fs-atomic.js"
import { SourceWriter } from "../../src/orchestrator/sources-write.js"
import {
  proposeWarn,
  confirm,
  undock,
  loadExonerations,
} from "../../src/orchestrator/exoneration.js"

const CA = "So11111111111111111111111111111111111111112"
const NOW = "2026-07-17T12:00:00.000Z"

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "tc-exon-"))
  const store = new StateStore(join(root, "agent", "state"))
  const writer = new SourceWriter(store)
  const layout = archiveLayout(join(root, "archive"))
  await writer.upsertNeutralSource({ sourceId: "tg_scam", handle: "scam", platform: "telegram" })
  return { store, writer, layout }
}

function warnArgs(writer: SourceWriter, layout: ReturnType<typeof archiveLayout>) {
  return {
    layout,
    writer,
    sourceId: "tg_scam",
    provenance: "telegram:scam",
    quotedMessageHash: sha256Bytes("buy this rug now"),
    scannerFlags: ["honeypot"],
    matchedAddress: CA,
    nowIso: NOW,
  }
}

describe("proposeWarn", () => {
  it("suspends the dock, increments adjacency, leaves score, and persists pending", async () => {
    const { store, writer, layout } = await setup()
    const proposal = await proposeWarn(warnArgs(writer, layout))

    expect(proposal.status).toBe("pending")
    expect(proposal.dockSuspended).toBe(true)
    expect(proposal.intentVerdict).toBe("warn")
    expect(proposal.rugAdjacencyIncremented).toBe(true)

    const record = store.loadSources().sources[0]
    expect(record?.docked).toBe(true)
    expect(record?.rugAdjacency).toBe(1)
    expect(record?.score).toBe(0.5)

    expect(loadExonerations(layout).proposals).toHaveLength(1)
  })

  it("is idempotent by deterministic id (no double dock or adjacency)", async () => {
    const { store, writer, layout } = await setup()
    const first = await proposeWarn(warnArgs(writer, layout))
    const second = await proposeWarn(warnArgs(writer, layout))
    expect(second.id).toBe(first.id)
    expect(loadExonerations(layout).proposals).toHaveLength(1)
    expect(store.loadSources().sources[0]?.rugAdjacency).toBe(1)
  })

  it("DMs only the allowlisted operator chat id supplied by the caller", async () => {
    const { writer, layout } = await setup()
    const sent: { chatId: string; text: string }[] = []
    await proposeWarn({
      ...warnArgs(writer, layout),
      notify: {
        operatorChatId: "42",
        sendDm: async (chatId, text) => { sent.push({ chatId, text }) },
      },
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.chatId).toBe("42")
    expect(sent[0]?.text).toMatch(/confirm ex-/u)
  })
})

describe("confirm / undock terminal transitions", () => {
  it("confirm keeps the dock and is idempotent", async () => {
    const { store, writer, layout } = await setup()
    const proposal = await proposeWarn(warnArgs(writer, layout))
    const confirmed = await confirm({ layout, writer, id: proposal.id, by: "operator-cli", nowIso: NOW })
    expect(confirmed.status).toBe("confirmed")
    expect(confirmed.resolvedBy).toBe("operator-cli")
    expect(store.loadSources().sources[0]?.docked).toBe(true)

    const again = await confirm({ layout, writer, id: proposal.id, by: "operator-telegram", nowIso: NOW })
    expect(again.status).toBe("confirmed")
    expect(again.resolvedBy).toBe("operator-cli")
  })

  it("undock clears the dock and is idempotent", async () => {
    const { store, writer, layout } = await setup()
    const proposal = await proposeWarn(warnArgs(writer, layout))
    const undocked = await undock({ layout, writer, id: proposal.id, by: "operator-telegram", nowIso: NOW })
    expect(undocked.status).toBe("undocked")
    expect(store.loadSources().sources[0]?.docked).toBe(false)

    await undock({ layout, writer, id: proposal.id, by: "operator-cli", nowIso: NOW })
    expect(store.loadSources().sources[0]?.docked).toBe(false)
  })

  it("refuses to flip a terminal proposal or resolve an unknown id", async () => {
    const { writer, layout } = await setup()
    const proposal = await proposeWarn(warnArgs(writer, layout))
    await confirm({ layout, writer, id: proposal.id, by: "operator-cli", nowIso: NOW })
    await expect(undock({ layout, writer, id: proposal.id, by: "operator-cli", nowIso: NOW }))
      .rejects.toThrow(/already confirmed/u)
    await expect(confirm({ layout, writer, id: "ex-missing", by: "operator-cli", nowIso: NOW }))
      .rejects.toThrow(/unknown proposal/u)
  })
})
