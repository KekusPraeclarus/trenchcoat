import { describe, expect, it } from "vitest"
import { resolveHostInstallScript } from "../../src/harness/deploy.js"

describe("resolveHostInstallScript", () => {
  it("selects the install script for the current platform", () => {
    const script = resolveHostInstallScript("/repo")
    if (process.platform === "linux") {
      expect(script).toBe("/repo/ops/install-systemd.sh")
    } else {
      expect(script).toBe("/repo/ops/install-launchd.sh")
    }
  })
})
