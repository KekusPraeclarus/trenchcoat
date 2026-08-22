import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scanWorktreeSecrets } from "../../src/lib/secret-scan.js"

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "secret-scan-"))
}

describe("scanWorktreeSecrets", () => {
  it("regex fallback flags a quoted API_KEY assignment", () => {
    const root = tempRoot()
    const id = "API" + "_KEY"
    const val = "sk-live-" + "not-real"
    writeFileSync(join(root, "leak.ts"), `const ${id} = "${val}"\n`)
    const result = scanWorktreeSecrets({
      worktreePath: root,
      files: ["leak.ts"],
      hasGitleaks: false,
    })
    expect(result.ok).toBe(false)
    expect(result.engine).toBe("regex-fallback")
    expect(result.detail).toContain("leak.ts")
  })

  it("regex fallback accepts empty assignment files", () => {
    const root = tempRoot()
    writeFileSync(join(root, "ok.ts"), 'const API_KEY = ""\n')
    const result = scanWorktreeSecrets({
      worktreePath: root,
      files: ["ok.ts"],
      hasGitleaks: false,
    })
    expect(result).toEqual({ ok: true, engine: "regex-fallback" })
  })

  it("regex fallback flags an unquoted HMAC_KEY assignment", () => {
    const root = tempRoot()
    const id = "TRENCHCOAT_ROUTER_HMAC_" + "KEY"
    const val = "abcdefgh" + "ijklmnop"
    writeFileSync(join(root, "leak.env"), `${id}=${val}\n`)
    const result = scanWorktreeSecrets({
      worktreePath: root,
      files: ["leak.env"],
      hasGitleaks: false,
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain("leak.env")
  })

  it("passes .gitleaks.toml when the worktree has one", () => {
    const root = tempRoot()
    const configPath = join(root, ".gitleaks.toml")
    writeFileSync(configPath, "title = \"test\"\n")
    const calls: Array<readonly string[]> = []
    const result = scanWorktreeSecrets({
      worktreePath: root,
      files: [],
      hasGitleaks: true,
      run: (_cwd, _cmd, args) => {
        calls.push(args)
        return { ok: true, detail: "" }
      },
    })
    expect(result.ok).toBe(true)
    expect(result.engine).toBe("gitleaks")
    expect(calls[0]).toEqual([
      "dir",
      "--no-banner",
      "--redact",
      "--config",
      configPath,
      root,
    ])
  })

  it("runs gitleaks dir against the worktree when the binary is present", () => {
    const root = tempRoot()
    mkdirSync(root, { recursive: true })
    const calls: Array<{ cmd: string; args: readonly string[] }> = []
    const result = scanWorktreeSecrets({
      worktreePath: root,
      files: [],
      hasGitleaks: true,
      run: (cwd, cmd, args) => {
        expect(cwd).toBe(root)
        calls.push({ cmd, args })
        return { ok: true, detail: "scanned" }
      },
    })
    expect(result).toEqual({
      ok: true,
      engine: "gitleaks",
      detail: "scanned",
    })
    expect(calls).toEqual([
      { cmd: "gitleaks", args: ["dir", "--no-banner", "--redact", root] },
    ])
  })

  it("falls back to regex when gitleaks is missing", () => {
    const root = tempRoot()
    writeFileSync(join(root, "clean.ts"), "export const n = 1\n")
    const result = scanWorktreeSecrets({
      worktreePath: root,
      files: ["clean.ts"],
      run: () => ({ ok: false, detail: "not-found" }),
    })
    expect(result).toEqual({ ok: true, engine: "regex-fallback" })
  })
})
