import { createHash, randomBytes } from "node:crypto"
import { openSync, fsyncSync, closeSync } from "node:fs"
import { mkdir, open, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export async function writeAtomicFile(
  path: string,
  contents: string | Buffer,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = join(dirname(path), `.${randomBytes(8).toString("hex")}.tmp`)
  await writeFile(tmp, contents, { mode, flag: "wx" })
  await rename(tmp, path)
}

/** Atomic write with best-effort fsync of file and parent directory */
export async function writeAtomicFileFsync(
  path: string,
  contents: string | Buffer,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const dir = dirname(path)
  const tmp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`)
  const handle = await open(tmp, "wx", mode)
  try {
    await handle.writeFile(contents)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, path)
  try {
    const dirFd = openSync(dir, "r")
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  } catch {
    // Directory fsync is best-effort on platforms that reject it
  }
}

export function sha256Bytes(bytes: Buffer | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}
