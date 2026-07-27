import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser, type LaunchOptions } from "playwright"
import { defaultRuntimeRoot } from "./deployment.js"
import { log } from "./log.js"

export type ChromiumInstallRunner = (cwd: string) => { ok: boolean }

function defaultInstallRunner(cwd: string): { ok: boolean } {
  const out = spawnSync("pnpm", ["exec", "playwright", "install", "chromium"], {
    cwd,
    stdio: "inherit",
    env: process.env,
  })
  return { ok: out.status === 0 }
}

/** Prefer deployed runtime, then this module's package root, then cwd */
export function defaultChromiumInstallCwd(): string {
  const runtime = defaultRuntimeRoot()
  if (existsSync(join(runtime, "package.json"))) return runtime
  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  if (existsSync(join(moduleRoot, "package.json"))) return moduleRoot
  return process.cwd()
}

/** Ensure Playwright Chromium is on disk before launch */
export function ensureChromiumInstalled(opts?: Readonly<{
  resolveInstallCwd?: () => string
  runInstall?: ChromiumInstallRunner
  resolveExecutablePath?: () => string
}>): void {
  const resolvePath = opts?.resolveExecutablePath ?? (() => chromium.executablePath())
  const path = resolvePath().trim()
  if (path && existsSync(path)) return

  const cwd = (opts?.resolveInstallCwd ?? defaultChromiumInstallCwd)()
  log.info("installing playwright chromium", { cwd })
  const run = opts?.runInstall ?? defaultInstallRunner
  const result = run(cwd)
  if (!result.ok) {
    throw new Error(
      "Failed to install Playwright Chromium — run: pnpm exec playwright install chromium",
    )
  }

  const after = resolvePath().trim()
  if (!after || !existsSync(after)) {
    throw new Error(
      "Playwright Chromium install finished but executable is still missing — run: pnpm exec playwright install chromium",
    )
  }
}

/** Launch Chromium after ensuring the browser binary exists */
export async function launchChromium(options?: LaunchOptions): Promise<Browser> {
  ensureChromiumInstalled()
  return chromium.launch(options)
}
