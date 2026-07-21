import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

describe("fomo origin producer confinement", () => {
  it("prop_inv_s19_no_source_registers_discoveredFrom_fomo", () => {
    const roots = [
      join(process.cwd(), "src/orchestrator"),
      join(process.cwd(), "src/wallets"),
      join(process.cwd(), "src/collectors"),
    ]
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          walk(path)
          continue
        }
        if (!name.endsWith(".ts")) continue
        if (path.includes("fomo-reconcile")) continue
        const text = readFileSync(path, "utf8")
        if (/discoveredFrom\s*:\s*["']fomo["']/.test(text)) offenders.push(path)
        if (/origin\s*:\s*["']fomo["']/.test(text) && !path.includes("schemas.ts")) {
          offenders.push(path)
        }
      }
    }
    for (const root of roots) walk(root)
    expect(offenders).toEqual([])
  })
})
