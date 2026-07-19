import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { assertRepoRoot, resolveHarnessRepoRoot } from "../../src/harness/pr.js"

describe("resolveHarnessRepoRoot", () => {
  it("prefers TRENCHCOAT_REPO_ROOT over cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-repo-"))
    mkdirSync(join(root, ".git"))
    writeFileSync(join(root, "package.json"), "{}\n")
    const resolved = resolveHarnessRepoRoot({
      env: { TRENCHCOAT_REPO_ROOT: root },
      cwd: "/",
    })
    expect(resolved).toBe(root)
  })

  it("falls back to cwd when env unset", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-cwd-"))
    mkdirSync(join(root, ".git"))
    writeFileSync(join(root, "package.json"), "{}\n")
    expect(resolveHarnessRepoRoot({ env: {}, cwd: root })).toBe(root)
  })

  it("rejects package.json-only trees (runtime layout)", () => {
    const runtime = mkdtempSync(join(tmpdir(), "tc-runtime-"))
    writeFileSync(join(runtime, "package.json"), "{}\n")
    expect(() => assertRepoRoot(runtime)).toThrow(/Not a trenchcoat repo root/)
    expect(() => resolveHarnessRepoRoot({ env: {}, cwd: runtime })).toThrow(
      /Not a trenchcoat repo root/,
    )
  })

  it("rejects bare slash cwd without env", () => {
    expect(() => resolveHarnessRepoRoot({ env: {}, cwd: "/" })).toThrow(
      /Not a trenchcoat repo root/,
    )
  })
})
