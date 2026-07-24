import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ensureWorktreeDeps,
  worktreeDepsMarker,
} from "../../src/lib/worktree-deps.js"

describe("ensureWorktreeDeps", () => {
  it("skips install when node_modules/.bin/tsc is present", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-deps-"))
    const marker = worktreeDepsMarker(root)
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true })
    writeFileSync(marker, "#!/bin/sh\n", { mode: 0o755 })
    let called = false
    const result = ensureWorktreeDeps({
      worktreePath: root,
      runInstall: () => {
        called = true
        return { ok: true, detail: "should-not-run" }
      },
    })
    expect(result).toEqual({ ok: true, detail: "deps-present", skipped: true })
    expect(called).toBe(false)
  })

  it("runs frozen pnpm install when marker is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-deps-"))
    const calls: Array<{ cmd: string; args: readonly string[] }> = []
    const result = ensureWorktreeDeps({
      worktreePath: root,
      runInstall: (cwd, cmd, args) => {
        expect(cwd).toBe(root)
        calls.push({ cmd, args })
        mkdirSync(join(root, "node_modules", ".bin"), { recursive: true })
        writeFileSync(worktreeDepsMarker(root), "#!/bin/sh\n", { mode: 0o755 })
        return { ok: true, detail: "ok" }
      },
    })
    expect(result.ok).toBe(true)
    expect(result.skipped).toBe(false)
    expect(result.detail).toBe("installed")
    expect(calls).toEqual([
      { cmd: "pnpm", args: ["install", "--frozen-lockfile"] },
    ])
  })

  it("fails closed when install exits non-zero", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-deps-"))
    const result = ensureWorktreeDeps({
      worktreePath: root,
      runInstall: () => ({ ok: false, detail: "ENOENT" }),
    })
    expect(result).toEqual({
      ok: false,
      detail: "ENOENT",
      skipped: false,
    })
  })

  it("fails closed when install succeeds but tsc marker is still missing", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-deps-"))
    const result = ensureWorktreeDeps({
      worktreePath: root,
      runInstall: () => ({ ok: true, detail: "ok" }),
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain("tsc missing")
  })
})
