import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

describe("redteam static", () => {
  it("agent scaffold never contains credential-shaped env names", () => {
    const files = walk(join(process.cwd(), "agent"))
    for (const file of files) {
      if (file.includes("/inbox/") || file.includes("/alpha-queue/")) continue
      const text = readFileSync(file, "utf8")
      expect(text).not.toMatch(/CURSOR_API_KEY|HELIUS_API_KEY|PRIVATE_KEY|0x[a-fA-F0-9]{64}/u)
    }
  })

  it("host prompts refuse instruction following for intent/wallet", () => {
    const intent = readFileSync(join(process.cwd(), "src/prompts/host.ts"), "utf8")
    expect(intent).toMatch(/shill or warn/u)
    expect(intent).toMatch(/cannot override hard exclusions/u)
  })
})
