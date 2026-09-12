import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import { StateStore } from "../../src/lib/state.js"
import {
  authIssuesPath,
  clearAuthIssue,
  loadAuthIssueFile,
  recordAuthIssue,
  renderAuthIssueOperatorNotice,
  shouldAlertAuthIssues,
} from "../../src/lib/auth-issues.js"
import {
  notifyOpenAuthIssues,
  reportSessionAuthFailureCode,
  reportSessionAuthIssue,
} from "../../src/orchestrator/auth-issue-notify.js"
import {
  buildHealthSnapshot,
  formatHealthText,
  healthCreatesReviewScope,
} from "../../src/orchestrator/health.js"

const AT = "2026-08-31T09:00:00.000Z"

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "tc-auth-issues-"))
}

describe("auth issues", () => {
  it("alerts on one open session", async () => {
    const home = tempHome()
    const sends: string[] = []
    const result = await reportSessionAuthIssue({
      source: "x",
      kind: "challenge",
      at: AT,
      detail: "home/fyp",
      home,
      send: async (text) => {
        sends.push(text)
      },
    })
    expect(result).toBe("alerted")
    expect(sends).toHaveLength(1)
    expect(sends[0]).toContain("Auth warning: 1 session needs a new login.")
    expect(sends[0]).toContain("x: challenge (home/fyp).")
    expect(sends[0]).toContain("Run tc auth twitter.")
    expect(sends[0]).toContain("This message is an operator notice.")
    expect(sends[0]).not.toContain("broadcast")
    expect(sends[0]).not.toContain(".trenchcoat")
    expect(shouldAlertAuthIssues({
      schema: 1,
      issues: { x: { kind: "challenge", since: AT } },
    })).toBe(true)
  })

  it("does not resend for the same open set", async () => {
    const home = tempHome()
    const sends: string[] = []
    const send = async (text: string) => {
      sends.push(text)
    }
    await reportSessionAuthIssue({
      source: "x",
      kind: "challenge",
      at: AT,
      home,
      send,
    })
    const repeat = await notifyOpenAuthIssues({ home, send, nowIso: AT })
    expect(repeat).toBe("skipped")
    expect(sends).toHaveLength(1)
  })

  it("alerts again when a second source opens", async () => {
    const home = tempHome()
    const sends: string[] = []
    const send = async (text: string) => {
      sends.push(text)
    }
    await reportSessionAuthIssue({
      source: "x",
      kind: "challenge",
      at: AT,
      detail: "home/fyp",
      home,
      send,
    })
    const second = await reportSessionAuthIssue({
      source: "fomo",
      kind: "session_expired",
      at: AT,
      home,
      send,
    })
    expect(second).toBe("alerted")
    expect(sends).toHaveLength(2)
    expect(sends[1]).toContain("Auth warning: 2 sessions need a new login.")
    expect(sends[1]).toContain("x: challenge (home/fyp).")
    expect(sends[1]).toContain("fomo: session_expired.")
    expect(sends[1]).toContain("Run tc auth twitter.")
    expect(sends[1]).toContain("Run tc auth fomo.")
  })

  it("does not re-alert when the open set shrinks", async () => {
    const home = tempHome()
    const sends: string[] = []
    const send = async (text: string) => {
      sends.push(text)
    }
    await reportSessionAuthIssue({
      source: "x",
      kind: "challenge",
      at: AT,
      home,
      send,
    })
    await reportSessionAuthIssue({
      source: "fomo",
      kind: "challenge",
      at: AT,
      home,
      send,
    })
    expect(sends).toHaveLength(2)

    await clearAuthIssue({ path: authIssuesPath(home), source: "fomo" })
    const afterClear = await notifyOpenAuthIssues({ home, send, nowIso: AT })
    expect(afterClear).toBe("skipped")
    expect(sends).toHaveLength(2)
  })

  it("alerts again after the open set shrinks and a new source opens", async () => {
    const home = tempHome()
    const sends: string[] = []
    const send = async (text: string) => {
      sends.push(text)
    }
    await reportSessionAuthIssue({
      source: "x",
      kind: "challenge",
      at: AT,
      home,
      send,
    })
    await reportSessionAuthIssue({
      source: "fomo",
      kind: "challenge",
      at: AT,
      home,
      send,
    })
    expect(sends).toHaveLength(2)

    await clearAuthIssue({ path: authIssuesPath(home), source: "fomo" })
    const afterClear = await notifyOpenAuthIssues({ home, send, nowIso: AT })
    expect(afterClear).toBe("skipped")

    const again = await reportSessionAuthIssue({
      source: "pump",
      kind: "session_expired",
      at: "2026-08-31T10:00:00.000Z",
      home,
      send,
    })
    expect(again).toBe("alerted")
    expect(sends).toHaveLength(3)
    expect(sends[2]).toContain("pump: session_expired.")
  })

  it("does not mark lastAlert when operator telegram env is missing", async () => {
    const home = tempHome()
    await recordAuthIssue({
      path: authIssuesPath(home),
      source: "x",
      kind: "challenge",
      at: AT,
    })
    const prevToken = process.env["TELEGRAM_BOT_TOKEN"]
    const prevOperator = process.env["TELEGRAM_OPERATOR_ID"]
    delete process.env["TELEGRAM_BOT_TOKEN"]
    delete process.env["TELEGRAM_OPERATOR_ID"]
    try {
      const result = await notifyOpenAuthIssues({ home, nowIso: AT })
      expect(result).toBe("skipped")
      expect(loadAuthIssueFile(authIssuesPath(home)).lastAlert).toBeUndefined()
    } finally {
      if (prevToken === undefined) delete process.env["TELEGRAM_BOT_TOKEN"]
      else process.env["TELEGRAM_BOT_TOKEN"] = prevToken
      if (prevOperator === undefined) delete process.env["TELEGRAM_OPERATOR_ID"]
      else process.env["TELEGRAM_OPERATOR_ID"] = prevOperator
    }
  })

  it("ignores non-auth failure codes", async () => {
    const home = tempHome()
    const result = await reportSessionAuthFailureCode({
      source: "fomo",
      code: "upstream",
      at: AT,
      home,
      send: async () => {
        throw new Error("must not send")
      },
    })
    expect(result).toBe("ignored")
  })

  it("keeps the first since for a repeated source", async () => {
    const home = tempHome()
    const path = authIssuesPath(home)
    await recordAuthIssue({
      path,
      source: "pump",
      kind: "challenge",
      at: "2026-08-31T08:00:00.000Z",
    })
    const next = await recordAuthIssue({
      path,
      source: "pump",
      kind: "session_expired",
      at: AT,
      detail: "retry",
    })
    expect(next.issues.pump?.since).toBe("2026-08-31T08:00:00.000Z")
    expect(next.issues.pump?.kind).toBe("session_expired")
    expect(next.issues.pump?.detail).toBe("retry")
  })

  it("renders host text without market copy", () => {
    const text = renderAuthIssueOperatorNotice({
      schema: 1,
      issues: {
        x: { kind: "challenge", since: AT },
        pump: { kind: "session_expired", since: AT },
      },
    })
    expect(text).toContain("Run tc auth pump.")
    expect(text).not.toMatch(/buy|sell|long|short/iu)
  })
})

describe("auth issues health", () => {
  it("flags concurrent open sessions and not a single session", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-health-auth-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const layout = await ensureArchive(archiveRoot)
    const state = new StateStore(join(agentRoot, "state"))
    await state.saveWatchlist({ schema: 1, entries: [] })

    await recordAuthIssue({
      path: authIssuesPath(root),
      source: "x",
      kind: "challenge",
      at: AT,
    })
    const one = await buildHealthSnapshot({
      agentRoot,
      archiveRoot,
      nowIso: AT,
      layout,
      home: root,
    })
    expect(one.authIssues.open).toEqual(["x"])
    expect(one.findings.some((f) => f.code === "auth-issues-concurrent")).toBe(false)
    expect(formatHealthText(one)).toContain("auth: open=x")
    expect(formatHealthText(one)).not.toContain("CONCURRENT")

    await recordAuthIssue({
      path: authIssuesPath(root),
      source: "fomo",
      kind: "session_expired",
      at: AT,
    })
    const two = await buildHealthSnapshot({
      agentRoot,
      archiveRoot,
      nowIso: AT,
      layout,
      home: root,
    })
    expect(two.authIssues.open).toEqual(["fomo", "x"])
    expect(two.findings.some((f) => f.code === "auth-issues-concurrent")).toBe(true)
    expect(formatHealthText(two)).toContain("auth: open=fomo,x CONCURRENT")
    expect(healthCreatesReviewScope(two)).toBe(true)
  })
})
