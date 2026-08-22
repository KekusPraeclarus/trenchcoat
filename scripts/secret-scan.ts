import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

const root = process.cwd()
const configPath = join(root, ".gitleaks.toml")
const args = [
  "git",
  "--no-banner",
  "--redact",
  ...(existsSync(configPath) ? ["--config", configPath] : []),
  root,
]

const out = spawnSync("gitleaks", args, {
  cwd: root,
  stdio: "inherit",
  env: process.env,
})

if (out.error && (out.error as NodeJS.ErrnoException).code === "ENOENT") {
  console.error("gitleaks is not installed. Install with: brew install gitleaks")
  process.exit(1)
}

process.exit(out.status ?? 1)
