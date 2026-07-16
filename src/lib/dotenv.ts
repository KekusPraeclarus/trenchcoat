import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

/** Load KEY=VALUE pairs from a .env file into process.env without overriding existing vars */
export function loadDotEnv(path = resolve(process.cwd(), ".env")): void {
  if (!existsSync(path)) return
  const text = readFileSync(path, "utf8")
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value
    }
  }
}
