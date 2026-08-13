/**
 * Resumable pump.fun web FAFO probe.
 * Raw artifacts stay under ~/.trenchcoat/probes/pump/ (mode 700).
 * Commands: discover | status | sanitize
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { writeAtomicFile } from "../src/lib/fs-atomic.js"
import { sanitizeCapturedJson } from "../src/collectors/pump/sanitize.js"
import { classifyPumpDiscoverObserve } from "../src/collectors/pump/request-policy.js"
import { assertPumpProfileReady, pumpProfileDir } from "../src/collectors/social/pump-auth.js"
import { ensureChromiumInstalled } from "../src/lib/playwright-chromium.js"
import { chromium } from "playwright"

const PROBE_ROOT = join(homedir(), ".trenchcoat", "probes", "pump")

type Manifest = {
  schema: 1
  runId: string
  startedAt: string
  updatedAt: string
  entries: ReadonlyArray<Readonly<{
    step: string
    at: string
    outcome: string
    note?: string
  }>>
}

function usage(): never {
  console.error(`usage: pnpm probe:pump <discover|status|sanitize> [--run-id <id>]`)
  process.exit(2)
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
}

function nowIso(): string {
  return new Date().toISOString()
}

function runDir(runId: string): string {
  return join(PROBE_ROOT, runId)
}

function manifestPath(runId: string): string {
  return join(runDir(runId), "manifest.json")
}

function loadManifest(runId: string): Manifest {
  const path = manifestPath(runId)
  if (!existsSync(path)) {
    return {
      schema: 1,
      runId,
      startedAt: nowIso(),
      updatedAt: nowIso(),
      entries: [],
    }
  }
  return JSON.parse(readFileSync(path, "utf8")) as Manifest
}

async function saveManifest(manifest: Manifest): Promise<void> {
  ensureDir(runDir(manifest.runId))
  const next = { ...manifest, updatedAt: nowIso() }
  await writeAtomicFile(manifestPath(manifest.runId), `${JSON.stringify(next, null, 2)}\n`, 0o600)
}

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

async function cmdDiscover(runId: string): Promise<void> {
  if (process.env["TRENCHCOAT_LIVE_PUMP"] !== "1") {
    console.error("Set TRENCHCOAT_LIVE_PUMP=1 to capture live pump.fun routes")
    process.exit(2)
  }
  assertPumpProfileReady(pumpProfileDir())
  ensureChromiumInstalled()
  ensureDir(runDir(runId))

  type SeenRequest = {
    method: string
    host: string
    path: string
    decision: string
    status?: number
  }
  const requests: SeenRequest[] = []
  const samples: unknown[] = []
  const pending: Promise<void>[] = []

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  })
  const context = await browser.newContext({
    storageState: assertPumpProfileReady(),
    viewport: { width: 1440, height: 900 },
  })
  await context.route("**/*", async (route) => {
    const request = route.request()
    const decision = classifyPumpDiscoverObserve(request.method(), request.url())
    let host = "invalid"
    let path = ""
    try {
      const parsed = new URL(request.url())
      host = parsed.hostname
      path = parsed.pathname
    } catch {
      host = "invalid"
    }
    requests.push({
      method: request.method().toUpperCase(),
      host,
      path,
      decision: decision.reason,
    })
    if (!decision.allow) {
      await route.abort("blockedbyclient")
      return
    }
    await route.continue()
  })

  const page = await context.newPage()
  page.on("response", (response) => {
    pending.push((async () => {
      const url = response.url()
      if (!/pump\.fun|privy\.io/iu.test(url)) return
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return
      }
      const type = response.headers()["content-type"] ?? ""
      const row = requests.find((entry) => (
        entry.host === parsed.hostname
        && entry.path === parsed.pathname
        && entry.status === undefined
      ))
      if (row) row.status = response.status()
      if (!/json/iu.test(type) || samples.length >= 8) return
      const text = await response.text().catch(() => "")
      if (!text) return
      try {
        samples.push({
          host: parsed.hostname,
          path: parsed.pathname,
          status: response.status(),
          body: sanitizeCapturedJson(JSON.parse(text) as unknown),
        })
      } catch {
        // ignore non-JSON
      }
    })())
  })

  const paths = ["/", "/explore", "/news", "/callouts/leaderboard"]
  for (const path of paths) {
    await page.goto(`https://pump.fun${path}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    })
    await page.waitForTimeout(8_000)
  }

  await Promise.all(pending)
  await context.close().catch(() => undefined)
  await browser.close().catch(() => undefined)

  const posts = [
    ...new Map(
      requests
        .filter((entry) => entry.method === "POST")
        .map((entry) => [`${entry.host}${entry.path}`, {
          host: entry.host,
          path: entry.path,
          decision: entry.decision,
          status: entry.status ?? null,
        }]),
    ).values(),
  ]
  const outPath = join(runDir(runId), "discover.json")
  await writeAtomicFile(outPath, `${JSON.stringify({
    schema: 1,
    runId,
    capturedAt: nowIso(),
    requestCount: requests.length,
    posts,
    samples,
  }, null, 2)}\n`, 0o600)

  const manifest = loadManifest(runId)
  const entries = [
    ...manifest.entries.filter((entry) => entry.step !== "discover"),
    {
      step: "discover",
      at: nowIso(),
      outcome: posts.length > 0 ? "captured" : "empty",
      note: `requests=${requests.length} posts=${posts.length} samples=${samples.length}`,
    },
  ]
  await saveManifest({ ...manifest, entries })
  console.log(JSON.stringify({
    runId,
    wrote: outPath,
    outcome: posts.length > 0 ? "captured" : "empty",
    posts: posts.map((post) => ({
      host: post.host,
      path: post.path,
      decision: post.decision,
      status: post.status,
    })),
  }, null, 2))
}

async function cmdStatus(runId: string | undefined): Promise<void> {
  ensureDir(PROBE_ROOT)
  if (runId) {
    const path = manifestPath(runId)
    if (!existsSync(path)) {
      console.log(JSON.stringify({ runId, status: "missing" }, null, 2))
      return
    }
    console.log(readFileSync(path, "utf8"))
    return
  }
  const runs = existsSync(PROBE_ROOT)
    ? readdirSync(PROBE_ROOT).filter((name) => existsSync(manifestPath(name)))
    : []
  console.log(JSON.stringify({ probeRoot: PROBE_ROOT, runs }, null, 2))
}

async function cmdSanitize(runId: string): Promise<void> {
  const manifest = loadManifest(runId)
  const rawDir = runDir(runId)
  const outDir = join(process.cwd(), "tests", "fixtures", "providers", "pump")
  ensureDir(outDir)
  if (existsSync(rawDir)) {
    for (const name of readdirSync(rawDir)) {
      if (!name.endsWith(".json")) continue
      const raw = JSON.parse(readFileSync(join(rawDir, name), "utf8")) as unknown
      const sanitized = sanitizeCapturedJson(raw)
      await writeAtomicFile(
        join(rawDir, `sanitized-${name}`),
        `${JSON.stringify(sanitized, null, 2)}\n`,
        0o600,
      )
    }
  }
  const unavailable = join(outDir, "unavailable.json")
  if (!existsSync(unavailable)) {
    writeFileSync(unavailable, `${JSON.stringify({
      error: "upstream unavailable",
      status: 502,
      body: "error code: 502",
    }, null, 2)}\n`)
  }
  const entries = [
    ...manifest.entries.filter((entry) => entry.step !== "sanitize"),
    {
      step: "sanitize",
      at: nowIso(),
      outcome: "stub",
      note: "No live bodies yet — placeholder fixtures retained under tests/fixtures/providers/pump/",
    },
  ]
  await saveManifest({ ...manifest, entries })
  console.log(JSON.stringify({ runId, fixtures: outDir, outcome: "stub" }, null, 2))
}

const cmd = process.argv[2]
const runId = argValue("--run-id") ?? `probe-${nowIso().slice(0, 10)}`

if (cmd === "discover") await cmdDiscover(runId)
else if (cmd === "status") await cmdStatus(argValue("--run-id"))
else if (cmd === "sanitize") await cmdSanitize(runId)
else usage()
