/**
 * Resumable Fomo web FAFO probe scaffold.
 * Raw artifacts stay under ~/.trenchcoat/probes/fomo/ (mode 700).
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

const PROBE_ROOT = join(homedir(), ".trenchcoat", "probes", "fomo")

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
  console.error(`usage: pnpm probe:fomo <discover|status|sanitize> [--run-id <id>]`)
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
  const manifest = loadManifest(runId)
  const note = "Stub: capture SPA routes after burner login (pnpm dev:cli auth fomo)"
  const entries = [
    ...manifest.entries.filter((entry) => entry.step !== "discover"),
    { step: "discover", at: nowIso(), outcome: "stub", note },
  ]
  await saveManifest({ ...manifest, entries })
  const stubPath = join(runDir(runId), "discover-stub.json")
  await writeAtomicFile(stubPath, `${JSON.stringify({
    schema: 1,
    runId,
    hosts: ["fomo.family", "prod-api.fomo.family"],
    status: "pending-live-capture",
  }, null, 2)}\n`, 0o600)
  console.log(JSON.stringify({ runId, wrote: stubPath, outcome: "stub" }, null, 2))
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
  const outDir = join(process.cwd(), "tests", "fixtures", "providers", "fomo")
  ensureDir(outDir)
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
      note: "No live bodies yet — placeholder fixtures retained under tests/fixtures/providers/fomo/",
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
