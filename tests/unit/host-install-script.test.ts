import { describe, expect, it } from "vitest"
import { resolveHostInstallScript } from "../../src/harness/deploy.js"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("resolveHostInstallScript", () => {
  it("selects the install script for the current platform", () => {
    const script = resolveHostInstallScript("/repo")
    if (process.platform === "linux") {
      expect(script).toBe("/repo/ops/install-systemd.sh")
    } else {
      expect(script).toBe("/repo/ops/install-launchd.sh")
    }
  })

  it("keeps a space after ! so dash can run find", () => {
    const body = readFileSync(join(process.cwd(), "ops/install-systemd.sh"), "utf8")
    expect(body).toMatch(/if ! find node_modules -name better_sqlite3\.node/u)
    expect(body).not.toMatch(/if !find /u)
  })
})
