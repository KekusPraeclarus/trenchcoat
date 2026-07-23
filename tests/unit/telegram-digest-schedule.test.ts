import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("telegram-digest schedule install", () => {
  it("registers a 20:00 Europe/London systemd calendar timer", () => {
    const script = readFileSync(
      join(process.cwd(), "ops/install-systemd.sh"),
      "utf8",
    )
    expect(script).toContain("trenchcoat-job-telegram-digest")
    expect(script).toContain('write_calendar_timer trenchcoat-job-telegram-digest "*-*-* 20:00:00 Europe/London"')
    expect(script).toMatch(/telegram-digest\) echo trenchcoat-job-telegram-digest/)
  })
})
