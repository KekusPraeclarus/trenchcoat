import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { resolveChatRepoRoot } from "../../src/chat/repo-root.js"

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "tc-chat-repo-"))
  mkdirSync(join(root, ".git"))
  mkdirSync(join(root, "ops"))
  mkdirSync(join(root, "docs"))
  writeFileSync(join(root, "package.json"), "{}\n")
  return realpathSync(root)
}

describe("resolveChatRepoRoot", () => {
  it("accepts an absolute checkout with project markers", () => {
    const root = makeRepo()
    expect(resolveChatRepoRoot({ env: { TRENCHCOAT_REPO_ROOT: root } })).toBe(root)
  })

  it("rejects missing env", () => {
    expect(() => resolveChatRepoRoot({ env: {} })).toThrow(/TRENCHCOAT_REPO_ROOT unset/)
  })

  it("rejects relative paths", () => {
    expect(() => resolveChatRepoRoot({
      env: { TRENCHCOAT_REPO_ROOT: "relative/path" },
    })).toThrow(/must be absolute/)
  })

  it("rejects missing directories", () => {
    expect(() => resolveChatRepoRoot({
      env: { TRENCHCOAT_REPO_ROOT: join(tmpdir(), "tc-missing-repo-xyz") },
    })).toThrow(/does not exist/)
  })

  it("rejects package.json-only trees", () => {
    const runtime = mkdtempSync(join(tmpdir(), "tc-runtime-"))
    writeFileSync(join(runtime, "package.json"), "{}\n")
    expect(() => resolveChatRepoRoot({
      env: { TRENCHCOAT_REPO_ROOT: runtime },
    })).toThrow(/Not a trenchcoat repo root/)
  })

  it("rejects checkouts missing ops/docs", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-partial-"))
    mkdirSync(join(root, ".git"))
    writeFileSync(join(root, "package.json"), "{}\n")
    expect(() => resolveChatRepoRoot({
      env: { TRENCHCOAT_REPO_ROOT: root },
    })).toThrow(/missing ops\/ or docs\//)
  })
})
