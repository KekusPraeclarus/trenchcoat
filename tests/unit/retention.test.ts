import { describe, expect, it } from "vitest"
import {
  mkdirSync,
  writeFileSync,
  utimesSync,
  existsSync,
  mkdtempSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  retainByAge,
  retainWorkspaceArtifacts,
} from "../../src/orchestrator/retention.js"

describe("workspace retention", () => {
  it("prunes old inbox dirs and chat reports but never archive", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-retain-"))
    const inboxOld = join(root, "inbox", "old-run")
    const inboxNew = join(root, "inbox", "new-run")
    const chatOld = join(root, "reports", "chat", "old.md")
    const chatNew = join(root, "reports", "chat", "new.md")
    const archiveProbe = join(root, "archive", "runs", "sealed")
    mkdirSync(inboxOld, { recursive: true })
    mkdirSync(inboxNew, { recursive: true })
    mkdirSync(join(root, "reports", "chat"), { recursive: true })
    mkdirSync(archiveProbe, { recursive: true })
    writeFileSync(join(inboxOld, "meta.json"), "{}\n")
    writeFileSync(join(inboxNew, "meta.json"), "{}\n")
    writeFileSync(chatOld, "old\n")
    writeFileSync(chatNew, "new\n")
    writeFileSync(join(archiveProbe, "keep.json"), "{}\n")

    const oldMs = Date.now() - 40 * 86_400_000
    const newMs = Date.now() - 1 * 86_400_000
    utimesSync(inboxOld, oldMs / 1000, oldMs / 1000)
    utimesSync(inboxNew, newMs / 1000, newMs / 1000)
    utimesSync(chatOld, oldMs / 1000, oldMs / 1000)
    utimesSync(chatNew, newMs / 1000, newMs / 1000)

    const report = retainWorkspaceArtifacts({
      agentRoot: root,
      inboxMaxAgeDays: 30,
      chatReportsMaxAgeDays: 30,
    })
    expect(existsSync(inboxOld)).toBe(false)
    expect(existsSync(inboxNew)).toBe(true)
    expect(existsSync(chatOld)).toBe(false)
    expect(existsSync(chatNew)).toBe(true)
    expect(existsSync(join(archiveProbe, "keep.json"))).toBe(true)
    expect(report.inboxRemoved.length).toBe(1)
    expect(report.chatReportsRemoved.length).toBe(1)
  })

  it("refuses to run retainByAge outside expected parent", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-retain-escape-"))
    const outside = join(root, "..", "not-under-agent")
    expect(() => retainByAge(outside, 30, Date.now(), { expectedParent: root }))
      .toThrow(/escapes expected parent/u)
  })
})
