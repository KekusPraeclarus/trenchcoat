import { mkdirSync, realpathSync, existsSync } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"
import { writeAtomicFile, sha256Bytes } from "./fs-atomic.js"
import {
  SnapshotEnvelopeSchema,
  type SnapshotEnvelope,
} from "../contracts/schemas.js"

function assertInsideRoot(root: string, candidate: string): string {
  const rootResolved = resolve(root)
  if (!existsSync(rootResolved)) {
    throw new Error(`Sandbox root missing: ${root}`)
  }
  const realRoot = realpathSync(rootResolved)
  const resolvedCandidate = resolve(candidate)

  let realCandidate: string
  if (existsSync(resolvedCandidate)) {
    realCandidate = realpathSync(resolvedCandidate)
  } else {
    const parts: string[] = []
    let parent = resolvedCandidate
    while (!existsSync(parent)) {
      const next = dirname(parent)
      if (next === parent) break
      parts.unshift(basename(parent))
      parent = next
    }
    if (!existsSync(parent)) {
      throw new Error(`Path escapes sandbox root: ${candidate}`)
    }
    realCandidate = join(realpathSync(parent), ...parts)
  }

  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
    throw new Error(
      existsSync(resolvedCandidate)
        ? `Symlink escapes sandbox root: ${candidate}`
        : `Path escapes sandbox root: ${candidate}`,
    )
  }
  return existsSync(resolvedCandidate) ? realCandidate : resolvedCandidate
}

function sanitizeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new TypeError(`Unsafe path segment: ${value}`)
  }
  return value
}

export class SnapshotWriter {
  constructor(private readonly agentRoot: string) {}

  async writeInbox(
    runId: string,
    name: string,
    envelope: SnapshotEnvelope,
  ): Promise<{ path: string; hash: `sha256:${string}` }> {
    const parsed = SnapshotEnvelopeSchema.parse(envelope)
    const safeRun = sanitizeSegment(runId)
    const safeName = sanitizeSegment(name)
    const dir = assertInsideRoot(this.agentRoot, join(this.agentRoot, "inbox", safeRun))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = assertInsideRoot(dir, join(dir, `${safeName}.json`))
    const body = `${JSON.stringify(parsed, null, 2)}\n`
    await writeAtomicFile(path, body)
    return { path, hash: sha256Bytes(body) }
  }

  /** Host-generated chart PNGs only — never write untrusted/scraped binaries */
  async writeChartPng(
    runId: string,
    name: string,
    png: Buffer,
    maxBytes = 2_000_000,
  ): Promise<{ path: string; hash: `sha256:${string}` }> {
    if (!Buffer.isBuffer(png) || png.length === 0 || png.length > maxBytes) {
      throw new TypeError("Chart PNG size is invalid")
    }
    if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
      throw new TypeError("Chart artifact must be a PNG")
    }
    const safeRun = sanitizeSegment(runId)
    const safeName = sanitizeSegment(name)
    if (!safeName.endsWith(".png") && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/u.test(safeName)) {
      throw new TypeError("Unsafe chart name")
    }
    const fileName = safeName.endsWith(".png") ? safeName : `${safeName}.png`
    const dir = assertInsideRoot(this.agentRoot, join(this.agentRoot, "inbox", safeRun, "charts"))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = assertInsideRoot(dir, join(dir, fileName))
    await writeAtomicFile(path, png)
    return { path, hash: sha256Bytes(png) }
  }

  async writeAlphaQueue(
    channel: string,
    messageId: string,
    envelope: SnapshotEnvelope,
  ): Promise<{ path: string; hash: `sha256:${string}` }> {
    const parsed = SnapshotEnvelopeSchema.parse(envelope)
    const safeChannel = sanitizeSegment(channel)
    const safeMessage = sanitizeSegment(messageId)
    const dir = assertInsideRoot(
      this.agentRoot,
      join(this.agentRoot, "alpha-queue", safeChannel),
    )
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = assertInsideRoot(dir, join(dir, `${safeMessage}.json`))
    if (existsSync(path)) {
      return { path, hash: sha256Bytes(`${JSON.stringify(parsed)}\n`) }
    }
    const body = `${JSON.stringify(parsed, null, 2)}\n`
    await writeAtomicFile(path, body, 0o600)
    return { path, hash: sha256Bytes(body) }
  }
}

export function sanitizePathSegment(value: string): string {
  return sanitizeSegment(value)
}

export function assertPathInside(root: string, candidate: string): string {
  return assertInsideRoot(root, candidate)
}

export function ensureParentInside(root: string, filePath: string): void {
  assertInsideRoot(root, dirname(filePath))
}
