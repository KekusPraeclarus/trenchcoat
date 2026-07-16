import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export async function ensureTwitterProfileDir(): Promise<string> {
  const dir = join(homedir(), ".trenchcoat", "twitter-profile")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, "README.txt"), "Playwright persistent burner profile (host-only, never under agent/)\n")
  return dir
}

export async function authTwitterInteractive(): Promise<void> {
  // Headful re-auth is operator-interactive and outside the agent sandbox.
  const dir = await ensureTwitterProfileDir()
  console.log(`Open a headed Playwright session against ${dir}`)
  console.log("Live automation is gated on twitter.scraping_permission_ref")
  throw new Error("Run with Playwright installed interactively — stub points at profile dir only")
}
