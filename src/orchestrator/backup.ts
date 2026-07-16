import { createHash } from "node:crypto"
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import { createGzip } from "node:zlib"

/** Local encrypted-ready backup stub: writes gzip tarball-like blob of a file list manifest hash */
export async function writeBackupManifest(
  archiveRoot: string,
  destDir: string,
  files: readonly string[],
): Promise<{ path: string; hash: `sha256:${string}` }> {
  mkdirSync(destDir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-")
  const path = join(destDir, `backup-${stamp}.json.gz`)
  const payload = JSON.stringify({ archiveRoot, files, createdAt: new Date().toISOString() })
  const hash = `sha256:${createHash("sha256").update(payload).digest("hex")}` as const
  const tmp = `${path}.tmp`
  await pipeline(
    async function* () { yield Buffer.from(payload) },
    createGzip(),
    createWriteStream(tmp),
  )
  const { rename } = await import("node:fs/promises")
  await rename(tmp, path)
  return { path, hash }
}

export function verifyBackupExists(path: string): boolean {
  return existsSync(path)
}
