import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildGrokIntakePayload } from "../../src/orchestrator/grok-intake.js"
import { appendDeskTicket, readDeskPending } from "../../src/router/desk-queue.js"

const TS = "2026-09-06T18:00:00.000Z"

function ticket(id: string, text: string) {
  return buildGrokIntakePayload({
    id,
    text,
    ts: TS,
    severity: "watch",
  })
}

describe("desk pull queue", () => {
  it("appends once per id and returns tickets after since_id", () => {
    const logPath = join(mkdtempSync(join(tmpdir(), "tc-desk-q-")), "desk_tickets.jsonl")
    const a = ticket("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "macro tape is quiet.")
    const b = ticket("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "STAX flow is the tell.")
    expect(appendDeskTicket(logPath, a)).toBe("appended")
    expect(appendDeskTicket(logPath, a)).toBe("duplicate")
    expect(appendDeskTicket(logPath, b)).toBe("appended")
    expect(readDeskPending(logPath, undefined, 50).map((row) => row.id)).toEqual([a.id, b.id])
    expect(readDeskPending(logPath, a.id, 50).map((row) => row.id)).toEqual([b.id])
    expect(readDeskPending(logPath, b.id, 50)).toEqual([])
  })

  it("skips corrupt lines and caps the page", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-desk-corrupt-"))
    const logPath = join(dir, "desk_tickets.jsonl")
    const a = ticket("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "one")
    const b = ticket("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "two")
    writeFileSync(logPath, `${JSON.stringify(a)}\nnot-json\n${JSON.stringify(b)}\n`)
    expect(readDeskPending(logPath, undefined, 1).map((row) => row.id)).toEqual([a.id])
  })
})
