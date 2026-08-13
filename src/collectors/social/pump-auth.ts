import { mkdirSync, writeFileSync, existsSync, chmodSync, readFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { homedir } from "node:os"
import { chromium } from "playwright"
import { defaultConfigPath } from "../../lib/config.js"
import { ensureChromiumInstalled } from "../../lib/playwright-chromium.js"

export function pumpProfileDir(): string {
  return join(homedir(), ".trenchcoat", "pump-profile")
}

const IDENTITY_COOKIE = /^(privy-token|privy-id-token|privy-access-token)$/iu

export type PumpAuthCookie = Readonly<{ name: string, value: string }>

/**
 * Anonymous pump.fun visits set Privy session cookies before login.
 * Only identity tokens count as logged in.
 */
export function pumpCookiesLookAuthed(cookies: readonly PumpAuthCookie[]): boolean {
  return cookies.some((cookie) => (
    IDENTITY_COOKIE.test(cookie.name) && cookie.value.length > 20
  ))
}

export type PumpStorageCookie = Readonly<{
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: "Strict" | "Lax" | "None"
}>

export type PumpStorageState = Readonly<{
  cookies: readonly PumpStorageCookie[]
  origins: ReadonlyArray<Readonly<{
    origin: string
    localStorage: ReadonlyArray<Readonly<{ name: string, value: string }>>
  }>>
}>

export function assertPumpImportPathSafe(path: string): string {
  const abs = resolve(path)
  if (abs.split(sep).includes("agent")) {
    throw new Error("Pump session import must not live under agent/")
  }
  return abs
}

function mapSameSite(raw: unknown): "Strict" | "Lax" | "None" {
  const text = String(raw ?? "Lax").toLowerCase()
  if (text === "strict") return "Strict"
  if (text === "none" || text === "no_restriction") return "None"
  return "Lax"
}

function cookieArrayFromUnknown(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === "object" && Array.isArray((raw as { cookies?: unknown }).cookies)) {
    return (raw as { cookies: unknown[] }).cookies
  }
  throw new Error("Cookie import must be a JSON array")
}

export function chromeCookiesToPlaywright(raw: unknown): PumpStorageCookie[] {
  const rows = cookieArrayFromUnknown(raw)
  const out: PumpStorageCookie[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      throw new Error("Cookie import row is invalid")
    }
    const cookie = row as Record<string, unknown>
    if (typeof cookie["name"] !== "string" || typeof cookie["value"] !== "string") {
      throw new Error("Cookie import row missing name or value")
    }
    const session = cookie["session"] === true
    const expiresRaw = cookie["expires"] ?? cookie["expirationDate"]
    const expiresNum = session || expiresRaw === undefined
      ? -1
      : Math.trunc(Number(expiresRaw))
    out.push({
      name: cookie["name"],
      value: cookie["value"],
      domain: typeof cookie["domain"] === "string" && cookie["domain"].length > 0
        ? cookie["domain"]
        : ".pump.fun",
      path: typeof cookie["path"] === "string" && cookie["path"].length > 0
        ? cookie["path"]
        : "/",
      expires: Number.isFinite(expiresNum) ? expiresNum : -1,
      httpOnly: cookie["httpOnly"] === true,
      secure: cookie["secure"] !== false,
      sameSite: mapSameSite(cookie["sameSite"]),
    })
  }
  return out
}

export function localStorageRecordToOrigin(
  raw: unknown,
  origin = "https://pump.fun",
): PumpStorageState["origins"][number] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("localStorage import must be a JSON object")
  }
  const record = raw as Record<string, unknown>
  if (typeof record["origin"] === "string" && Array.isArray(record["localStorage"])) {
    const items: Array<{ name: string, value: string }> = []
    for (const item of record["localStorage"]) {
      if (!item || typeof item !== "object") {
        throw new Error("localStorage import row is invalid")
      }
      const entry = item as Record<string, unknown>
      if (typeof entry["name"] !== "string" || typeof entry["value"] !== "string") {
        throw new Error("localStorage import row missing name or value")
      }
      items.push({ name: entry["name"], value: entry["value"] })
    }
    return { origin: record["origin"], localStorage: items }
  }
  const localStorage: Array<{ name: string, value: string }> = []
  for (const [name, value] of Object.entries(record)) {
    if (typeof value !== "string") {
      throw new Error("localStorage import values must be strings")
    }
    localStorage.push({ name, value })
  }
  return { origin, localStorage }
}

function readImportJson(path: string): unknown {
  const abs = assertPumpImportPathSafe(path)
  if (!existsSync(abs)) {
    throw new Error("Pump session import file is missing")
  }
  try {
    return JSON.parse(readFileSync(abs, "utf8"))
  } catch {
    throw new Error("Pump session import file is not valid JSON")
  }
}

function readImportText(path: string): string {
  const abs = assertPumpImportPathSafe(path)
  if (!existsSync(abs)) {
    throw new Error("Pump session import file is missing")
  }
  return readFileSync(abs, "utf8")
}

/**
 * Parse a DevTools Network Cookie request header. Do not log the header.
 */
export function cookieHeaderToPlaywright(
  header: string,
  domain = ".pump.fun",
): PumpStorageCookie[] {
  const text = header.trim().replace(/^cookie:\s*/iu, "")
  if (text.length === 0) {
    throw new Error("Cookie header import is empty")
  }
  const out: PumpStorageCookie[] = []
  for (const part of text.split(";")) {
    const piece = part.trim()
    if (!piece) continue
    const eq = piece.indexOf("=")
    if (eq <= 0) continue
    const name = piece.slice(0, eq).trim()
    const value = piece.slice(eq + 1).trim()
    if (!name || value.length === 0) continue
    out.push({
      name,
      value,
      domain,
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    })
  }
  if (out.length === 0) {
    throw new Error("Cookie header import has no name=value pairs")
  }
  return out
}

function originLooksAuthed(
  origins: PumpStorageState["origins"],
): boolean {
  return origins.some((origin) => (
    origin.localStorage.some((item) => (
      /privy/iu.test(item.name) && item.value.length > 40
    ))
  ))
}

function asStorageState(raw: unknown): PumpStorageState {
  if (!raw || typeof raw !== "object") {
    throw new Error("storage-state import is malformed")
  }
  const record = raw as { cookies?: unknown, origins?: unknown }
  const cookies = Array.isArray(record.cookies)
    ? chromeCookiesToPlaywright(record.cookies)
    : []
  const origins = Array.isArray(record.origins)
    ? record.origins.map((row) => localStorageRecordToOrigin(row))
    : []
  if (cookies.length === 0 && origins.length === 0) {
    throw new Error("storage-state import has no cookies or localStorage")
  }
  return { cookies, origins }
}

export async function waitForOperatorEnter(
  timeoutMs: number,
  io: Readonly<{
    stdin: NodeJS.ReadableStream
    stdout: { write: (chunk: string) => unknown }
  }> = process,
): Promise<void> {
  io.stdout.write("Log in in the browser.\n")
  io.stdout.write("Press Enter in this terminal when the authenticated app is visible.\n")
  const stdin = io.stdin
  if ("resume" in stdin && typeof stdin.resume === "function") {
    stdin.resume()
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stdin.off("data", onData)
        reject(new Error("Timed out waiting for pump.fun login. Re-run `pnpm dev:cli auth pump`."))
      }, timeoutMs)
      const onData = () => {
        clearTimeout(timer)
        resolve()
      }
      stdin.once("data", onData)
    })
  } finally {
    if ("pause" in stdin && typeof stdin.pause === "function") {
      stdin.pause()
    }
  }
}

export async function ensurePumpProfileDir(): Promise<string> {
  const dir = pumpProfileDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(dir, "README.txt"),
    "Playwright persistent burner profile for pump.fun (host-only, never under agent/).\n"
      + "Created by: pnpm dev:cli auth pump\n",
  )
  try { chmodSync(dir, 0o700) } catch { /* ignore */ }
  return dir
}

export async function importPumpSession(opts: Readonly<{
  destDir?: string
  storageStatePath?: string
  cookiesPath?: string
  cookieHeaderPath?: string
  cookieDomain?: string
  localStoragePath?: string
}>): Promise<Readonly<{
  path: string
  cookieCount: number
  localStorageCount: number
  looksAuthed: boolean
}>> {
  const chromeOrHeader = Boolean(opts.cookiesPath || opts.cookieHeaderPath || opts.localStoragePath)
  if (opts.storageStatePath && chromeOrHeader) {
    throw new Error("Use --import alone, or --import-cookies / --import-cookie-header / --import-local-storage")
  }
  if (!opts.storageStatePath && !chromeOrHeader) {
    throw new Error("Pump session import needs a file")
  }

  const destDir = assertPumpImportPathSafe(opts.destDir ?? await ensurePumpProfileDir())
  mkdirSync(destDir, { recursive: true, mode: 0o700 })

  let state: PumpStorageState
  if (opts.storageStatePath) {
    state = asStorageState(readImportJson(opts.storageStatePath))
  } else {
    const fromJson = opts.cookiesPath
      ? chromeCookiesToPlaywright(readImportJson(opts.cookiesPath))
      : []
    const fromHeader = opts.cookieHeaderPath
      ? cookieHeaderToPlaywright(readImportText(opts.cookieHeaderPath), opts.cookieDomain ?? ".pump.fun")
      : []
    const cookies = [...fromJson, ...fromHeader]
    const lsRaw = opts.localStoragePath ? readImportJson(opts.localStoragePath) : null
    const origins = lsRaw
      ? [
          localStorageRecordToOrigin(lsRaw, "https://pump.fun"),
          localStorageRecordToOrigin(lsRaw, "https://www.pump.fun"),
        ]
      : []
    if (cookies.length === 0 && origins.every((origin) => origin.localStorage.length === 0)) {
      throw new Error("Pump session import has no cookies or localStorage")
    }
    state = { cookies, origins }
  }

  const statePath = join(destDir, "storage-state.json")
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  chmodSync(statePath, 0o600)

  const localStorageCount = new Set(
    state.origins.flatMap((origin) => origin.localStorage.map((item) => item.name)),
  ).size
  return {
    path: statePath,
    cookieCount: state.cookies.length,
    localStorageCount,
    looksAuthed: pumpCookiesLookAuthed(state.cookies) || originLooksAuthed(state.origins),
  }
}

/**
 * Headful burner login. Operator logs in manually. Session stays under
 * ~/.trenchcoat/pump-profile — never under agent/.
 */
export async function authPumpInteractive(): Promise<void> {
  const dir = await ensurePumpProfileDir()

  if (!existsSync(defaultConfigPath())) {
    console.warn("warning: ~/.trenchcoat/config.json missing — run `pnpm dev:cli init` after auth")
  }

  ensureChromiumInstalled()

  console.log("")
  console.log("Opening headed Chromium for pump.fun burner login.")
  console.log(`Profile: ${dir}`)
  console.log("1. Log in to the authorized zero-funds burner in the browser window")
  console.log("2. Wait until the authenticated app loads")
  console.log("3. Press Enter in this terminal to save the session (up to 10 minutes)")
  console.log("")

  const context = await chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  })

  try {
    const page = context.pages()[0] ?? await context.newPage()
    await page.goto("https://pump.fun", { waitUntil: "domcontentloaded", timeout: 60_000 })
    await waitForOperatorEnter(10 * 60_000)

    const statePath = join(dir, "storage-state.json")
    await context.storageState({ path: statePath })
    chmodSync(statePath, 0o600)

    const cookies = await context.cookies()
    if (!pumpCookiesLookAuthed(cookies)) {
      console.warn("warning: no Privy identity cookie yet — re-run if the login page was still open")
    }

    console.log("")
    console.log(`Saved burner session → ${statePath}`)
    console.log("Live scrapes reuse this profile. They do not open a login window.")
  } finally {
    await context.close()
  }
}

export function assertPumpProfileReady(profileDirectory = pumpProfileDir()): string {
  const state = join(profileDirectory, "storage-state.json")
  if (!existsSync(state)) {
    throw new Error("No pump.fun session — run `pnpm dev:cli auth pump` first")
  }
  try {
    const raw = JSON.parse(readFileSync(state, "utf8")) as {
      cookies?: unknown[]
      origins?: unknown[]
    }
    if (!Array.isArray(raw.cookies) && !Array.isArray(raw.origins)) {
      throw new Error("malformed")
    }
  } catch {
    throw new Error("pump.fun storage-state.json is malformed — re-run `pnpm dev:cli auth pump`")
  }
  return state
}

export function pumpSessionExists(): boolean {
  try {
    assertPumpProfileReady()
    return true
  } catch {
    return false
  }
}
