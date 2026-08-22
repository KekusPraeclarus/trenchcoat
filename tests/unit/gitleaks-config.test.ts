import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const repoConfig = readFileSync(join(process.cwd(), ".gitleaks.toml"), "utf8")
const gitleaks = spawnSync("gitleaks", ["version"], { encoding: "utf8" })
const hasGitleaks = gitleaks.status === 0

function scanDir(contents: Record<string, string>): {
  status: number | null
  findings: number
} {
  const root = mkdtempSync(join(tmpdir(), "gitleaks-cfg-"))
  writeFileSync(join(root, ".gitleaks.toml"), repoConfig)
  for (const [rel, body] of Object.entries(contents)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }
  const report = join(root, "report.json")
  const out = spawnSync(
    "gitleaks",
    ["dir", "--no-banner", "--config", join(root, ".gitleaks.toml"), "--report-format", "json", "--report-path", report, root],
    { encoding: "utf8" },
  )
  let findings = 0
  try {
    const parsed = JSON.parse(readFileSync(report, "utf8")) as unknown
    findings = Array.isArray(parsed) ? parsed.length : 0
  } catch {
    findings = 0
  }
  return { status: out.status, findings }
}

describe.skipIf(!hasGitleaks)("gitleaks config", () => {
  it("still flags a provider key assignment under tests/", () => {
    const id = "HELIUS_" + "API_KEY"
    const val = "hk_live_" + "not_a_real_secret_xx"
    const result = scanDir({
      "tests/unit/leak.test.ts": `const ${id} = "${val}"\n`,
    })
    expect(result.status).not.toBe(0)
    expect(result.findings).toBeGreaterThan(0)
  })

  it("allows a public mint address fixture under tests/", () => {
    const result = scanDir({
      "tests/unit/ok.test.ts":
        'const TOKEN = "EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA"\n',
    })
    expect(result.status).toBe(0)
    expect(result.findings).toBe(0)
  })

  it("flags a Discord webhook URL", () => {
    const host = "https://discord.com/api/web" + "hooks"
    const token = `${"a".repeat(34)}${"B".repeat(34)}`
    const result = scanDir({
      "src/leak.ts": `const u = "${host}/123456789012345678/${token}"\n`,
    })
    expect(result.status).not.toBe(0)
    expect(result.findings).toBeGreaterThan(0)
  })

  it("flags an unquoted FARCASTER_APP_MNEMONIC assignment", () => {
    const id = "FARCASTER_APP_" + "MNEMONIC"
    const words = Array(12).fill("abandon").join(" ")
    const result = scanDir({
      "ops/leak.env": `${id}=${words}\n`,
    })
    expect(result.status).not.toBe(0)
    expect(result.findings).toBeGreaterThan(0)
  })
})
