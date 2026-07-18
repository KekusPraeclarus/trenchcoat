import { createHash } from "node:crypto"
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { pipeline } from "node:stream/promises"
import { createGzip } from "node:zlib"

const MAX_LISTED_FILES = 50_000

/** Walk archive for sealed manifests, structured records, and blobs (paths relative to archiveRoot) */
export function listArchiveBackupFiles(archiveRoot: string): string[] {
  if (!existsSync(archiveRoot)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    if (out.length >= MAX_LISTED_FILES) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= MAX_LISTED_FILES) return
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      out.push(relative(archiveRoot, absolute))
    }
  }
  walk(archiveRoot)
  return out.sort()
}

/** Local encrypted-ready backup stub: writes gzip manifest of archive file list + content hashes sample */
export async function writeBackupManifest(
  archiveRoot: string,
  destDir: string,
  files: readonly string[],
): Promise<{ path: string; hash: `sha256:${string}`; verifiedPath: string }> {
  mkdirSync(destDir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-")
  const path = join(destDir, `backup-${stamp}.json.gz`)
  const sampleHashes: Record<string, string> = {}
  const sampleLimit = Math.min(32, files.length)
  for (let i = 0; i < sampleLimit; i += 1) {
    const rel = files[i]!
    const absolute = join(archiveRoot, rel)
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue
    const { readFileSync } = await import("node:fs")
    sampleHashes[rel] = createHash("sha256").update(readFileSync(absolute)).digest("hex")
  }
  const payload = JSON.stringify({
    archiveRoot,
    files,
    sampleHashes,
    createdAt: new Date().toISOString(),
  })
  const hash = `sha256:${createHash("sha256").update(payload).digest("hex")}` as const
  const tmp = `${path}.tmp`
  await pipeline(
    async function* () { yield Buffer.from(payload) },
    createGzip(),
    createWriteStream(tmp),
  )
  const { rename } = await import("node:fs/promises")
  await rename(tmp, path)
  const verifiedPath = join(destDir, "last-verified.json")
  writeFileSync(
    verifiedPath,
    `${JSON.stringify({ path, hash, createdAt: new Date().toISOString(), fileCount: files.length }, null, 2)}\n`,
    { mode: 0o600 },
  )
  return { path, hash, verifiedPath }
}

export function verifyBackupExists(path: string): boolean {
  return existsSync(path)
}
