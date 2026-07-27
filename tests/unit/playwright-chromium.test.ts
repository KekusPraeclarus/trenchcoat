import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureChromiumInstalled } from "../../src/lib/playwright-chromium.js"

describe("ensureChromiumInstalled", () => {
  it("skips install when injected executablePath exists", () => {
    const root = mkdtempSync(join(tmpdir(), "pw-chromium-"))
    const binary = join(root, "chrome")
    writeFileSync(binary, "", { mode: 0o755 })
    let called = false
    ensureChromiumInstalled({
      resolveExecutablePath: () => binary,
      runInstall: () => {
        called = true
        return { ok: true }
      },
    })
    expect(called).toBe(false)
  })

  it("runs install with expected cwd when missing", () => {
    const root = mkdtempSync(join(tmpdir(), "pw-chromium-"))
    const binary = join(root, "chrome")
    const cwd = join(root, "runtime")
    const calls: string[] = []
    let present = false
    ensureChromiumInstalled({
      resolveExecutablePath: () => (present ? binary : join(root, "missing")),
      resolveInstallCwd: () => cwd,
      runInstall: (installCwd) => {
        calls.push(installCwd)
        writeFileSync(binary, "", { mode: 0o755 })
        present = true
        return { ok: true }
      },
    })
    expect(calls).toEqual([cwd])
  })

  it("throws when install fails", () => {
    const root = mkdtempSync(join(tmpdir(), "pw-chromium-"))
    expect(() =>
      ensureChromiumInstalled({
        resolveExecutablePath: () => join(root, "missing"),
        resolveInstallCwd: () => root,
        runInstall: () => ({ ok: false }),
      }),
    ).toThrow(/Failed to install Playwright Chromium/)
  })

  it("throws when install ok but binary still missing", () => {
    const root = mkdtempSync(join(tmpdir(), "pw-chromium-"))
    expect(() =>
      ensureChromiumInstalled({
        resolveExecutablePath: () => join(root, "missing"),
        resolveInstallCwd: () => root,
        runInstall: () => ({ ok: true }),
      }),
    ).toThrow(/executable is still missing/)
  })
})
