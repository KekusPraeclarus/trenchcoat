import { createHash } from "node:crypto"
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs"
import { mkdir, readFile, readdir, rename } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createGzip, createGunzip } from "node:zlib"
import { pipeline } from "node:stream/promises"
import { writeAtomicFile, sha256Bytes } from "./fs-atomic.js"
import { sha256Json, type JsonValue } from "./canonical-json.js"

export type ArchiveLayout = Readonly<{
  root: string
  runs: string
  decisions: string
  outcomes: string
  epochs: string
  transactions: string
  telemetry: string
  marketBlobs: string
  wallets: string
  routerOutbox: string
}>

export function archiveLayout(root: string): ArchiveLayout {
  return {
    root,
    runs: join(root, "runs"),
    decisions: join(root, "decisions"),
    outcomes: join(root, "outcomes"),
    epochs: join(root, "epochs"),
    transactions: join(root, "transactions"),
    telemetry: join(root, "telemetry", "runs"),
    marketBlobs: join(root, "market", "blobs"),
    wallets: join(root, "wallets"),
    routerOutbox: join(root, "router-outbox"),
  }
}

export async function ensureArchive(root: string): Promise<ArchiveLayout> {
  const layout = archiveLayout(root)
  for (const path of Object.values(layout)) {
    await mkdir(path, { recursive: true, mode: 0o700 })
  }
  return layout
}

export async function writeJsonRecord(
  path: string,
  value: JsonValue,
): Promise<`sha256:${string}`> {
  const body = `${JSON.stringify(value, null, 2)}\n`
  await writeAtomicFile(path, body)
  return sha256Bytes(body)
}

export async function putMarketBlob(
  layout: ArchiveLayout,
  payload: JsonValue,
): Promise<`sha256:${string}`> {
  const hash = sha256Json(payload)
  const hex = hash.slice("sha256:".length)
  const path = join(layout.marketBlobs, `${hex}.json.gz`)
  if (existsSync(path)) return hash
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeAtomicFile(tmp.replace(/\.tmp$/u, ".json"), JSON.stringify(payload))
    const jsonPath = tmp.replace(/\.tmp$/u, ".json")
    await pipeline(createReadStream(jsonPath), createGzip(), createWriteStream(tmp))
    await rename(tmp, path)
    await writeAtomicFile(`${path}.sha`, `${hash}\n`)
    unlinkSync(jsonPath)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
  return hash
}

export async function readMarketBlob(
  layout: ArchiveLayout,
  hash: `sha256:${string}`,
): Promise<JsonValue> {
  const path = join(layout.marketBlobs, `${hash.slice("sha256:".length)}.json.gz`)
  const chunks: Buffer[] = []
  const gunzip = createGunzip()
  await pipeline(createReadStream(path), gunzip, async function* (source) {
    for await (const chunk of source) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      yield chunk
    }
  })
  const text = Buffer.concat(chunks).toString("utf8")
  const digest = `sha256:${createHash("sha256").update(text).digest("hex")}`
  if (digest !== hash) {
    throw new Error(`Market blob hash mismatch for ${hash}`)
  }
  return JSON.parse(text) as JsonValue
}

export async function listRunFiles(runDir: string): Promise<string[]> {
  if (!existsSync(runDir)) return []
  return readdir(runDir)
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown
}

export async function copyDirectoryManifest(
  sourceDir: string,
  destDir: string,
): Promise<Record<string, `sha256:${string}`>> {
  await mkdir(destDir, { recursive: true, mode: 0o700 })
  const files = await readdir(sourceDir)
  const manifest: Record<string, `sha256:${string}`> = {}
  for (const file of files) {
    const source = join(sourceDir, file)
    const dest = join(destDir, file)
    const body = await readFile(source)
    await writeAtomicFile(dest, body)
    manifest[file] = sha256Bytes(body)
  }
  return manifest
}
