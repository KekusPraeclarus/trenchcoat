import { createHash, randomBytes } from "node:crypto"
import { mkdir, rename, writeFile } from "node:fs/promises"
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

export function sha256Bytes(bytes: Buffer | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}
