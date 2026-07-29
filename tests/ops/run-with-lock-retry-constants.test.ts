import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("run-with-lock-retry.sh constants", () => {
  it("uses MAX_ATTEMPTS=8 and 60–300s jitter delay", () => {
    const script = readFileSync(
      join(process.cwd(), "ops/run-with-lock-retry.sh"),
      "utf8",
    )
    expect(script).toMatch(/MAX_ATTEMPTS=8/u)
    expect(script).toMatch(/delay=\$\(\(60 \+ \(r % 241\)\)\)/u)
  })
})
