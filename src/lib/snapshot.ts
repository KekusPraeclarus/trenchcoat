import { mkdirSync, realpathSync, existsSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { writeAtomicFile, sha256Bytes } from "./fs-atomic.js"
import {
  SnapshotEnvelopeSchema,
  type SnapshotEnvelope,
} from "../contracts/schemas.js"

function assertInsideRoot(root: string, candidate: string): string {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  if (
    resolvedCandidate !== resolvedRoot
    && !resolvedCandidate.startsWith(resolvedRoot + sep)
  ) {
    throw new Error(`Path escapes sandbox root: ${candidate}`)
  }
  if (existsSync(resolvedCandidate)) {
    const real = realpathSync(resolvedCandidate)
    if (real !== resolvedRoot && !real.startsWith(resolvedRoot + sep)) {
      throw new Error(`Symlink escapes sandbox root: ${candidate}`)
    }
  }
  return resolvedCandidate
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
