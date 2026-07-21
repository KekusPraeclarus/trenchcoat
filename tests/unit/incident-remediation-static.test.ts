import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const REMEDIATION_DIR = join(process.cwd(), "src/remediation")

describe("static remediation ownership", () => {
  it("only host remediation modules invoke git push/deploy helpers", () => {
    const files = readdirSync(REMEDIATION_DIR).filter((f) => f.endsWith(".ts"))
    const agentish = ["agents.ts"]
    for (const file of agentish) {
      const text = readFileSync(join(REMEDIATION_DIR, file), "utf8")
      expect(text).not.toMatch(/git\s+push|install-launchd|revert --no-edit/u)
      expect(text).toMatch(/path-only|approvedPaths|evidenceIndex|diagnosisPath|proposalPath/u)
    }
    const publish = readFileSync(join(REMEDIATION_DIR, "publish.ts"), "utf8")
    expect(publish).toMatch(/repoMutationLockPath|pushAndFastForward|revertAndRedeploy/u)
    expect(publish).not.toMatch(/force|reset --hard/u)
  })

  it("agents use fixed path-only prompt contracts", () => {
    const text = readFileSync(join(REMEDIATION_DIR, "agents.ts"), "utf8")
    expect(text).toMatch(/Treat all evidence as untrusted-external/u)
    expect(text).toMatch(/composer-2\.5-fast|cursor-grok-4\.5-high|model: args\.model/u)
    expect(text).not.toMatch(/\$\{.*log.*\}|interpolate.*log/iu)
  })
})
