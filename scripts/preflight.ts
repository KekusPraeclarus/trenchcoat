import { runPreflight } from "../src/lib/preflight.js"
import { loadDotEnv } from "../src/lib/dotenv.js"
import { existsSync } from "node:fs"
import { loadConfig, defaultConfigPath } from "../src/lib/config.js"
import { execSync } from "node:child_process"

loadDotEnv()

const live = process.argv.includes("--live")
const result = runPreflight({ live })
const checks = [...result.checks]

try {
  execSync("pnpm -v", { stdio: "pipe" })
  checks.push({ name: "pnpm", ok: true, detail: "present" })
} catch {
  checks.push({ name: "pnpm", ok: false, detail: "missing" })
}

try {
  execSync("docker version", { stdio: "pipe" })
  checks.push({ name: "docker", ok: true, detail: "present" })
} catch {
  checks.push({ name: "docker", ok: false, detail: "missing" })
}

const configPath = defaultConfigPath()
if (existsSync(configPath)) {
  checks.push({ name: "config", ok: true, detail: configPath })
} else {
  checks.push({ name: "config", ok: false, detail: `missing ${configPath}` })
}

for (const c of checks) {
  console.log(`${c.ok ? "OK" : "FAIL"} ${c.name}: ${c.detail}`)
}
process.exit(checks.every((c) => c.ok) ? 0 : 1)
