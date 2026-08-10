import { existsSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs"
import { basename, join, resolve } from "node:path"

export type WorkspaceRetentionReport = Readonly<{
  schema: 1
  inboxRemoved: readonly string[]
  chatReportsRemoved: readonly string[]
  alphaAcksRemoved: readonly string[]
  narrativeDossiersRemoved: readonly string[]
  inboxMaxAgeDays: number
  chatReportsMaxAgeDays: number
  alphaAckMaxAgeDays: number
  narrativeDossierMaxAgeDays: number
}>

const MS_PER_DAY = 86_400_000

/**
 * Delete direct children of dir older than maxAgeDays.
 * Refuses to operate outside an expected parent root (path confinement).
 */
export function retainByAge(
  dir: string,
  maxAgeDays: number,
  nowMs = Date.now(),
  opts?: Readonly<{ expectedParent?: string }>,
): string[] {
  const removed: string[] = []
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 1) {
    throw new TypeError(`invalid maxAgeDays: ${maxAgeDays}`)
  }
  const resolvedDir = resolve(dir)
  if (opts?.expectedParent) {
    const parent = resolve(opts.expectedParent)
    if (resolvedDir !== parent && !resolvedDir.startsWith(parent + "/")) {
      throw new Error(`retention path escapes expected parent: ${resolvedDir}`)
    }
  }
  if (!statSync(resolvedDir, { throwIfNoEntry: false })?.isDirectory()) return removed
  for (const name of readdirSync(resolvedDir)) {
    if (name === "." || name === ".." || name.includes("\0")) continue
    if (name.includes("..")) continue
    const path = join(resolvedDir, name)
    const st = statSync(path, { throwIfNoEntry: false })
    if (!st) continue
    const ageDays = (nowMs - st.mtimeMs) / MS_PER_DAY
    if (ageDays > maxAgeDays) {
      rmSync(path, { recursive: true, force: true })
      removed.push(path)
    }
  }
  return removed
}

function isOlderThan(path: string, maxAgeDays: number, nowMs: number): boolean {
  const st = statSync(path, { throwIfNoEntry: false })
  if (!st?.isFile()) return false
  return (nowMs - st.mtimeMs) / MS_PER_DAY > maxAgeDays
}

const ACK_NAME_RE = /^(.+)-(\d+)\.md$/u
const LEGACY_ACK_NAME_RE = /^alpha-ack-(.+)-(\d+)\.md$/u

/**
 * Delete alpha-ack tombstones whose queue message is already purged and whose
 * age exceeds maxAgeDays. The archived alpha-digest receipt is the durable
 * record after purge (INV-Q2; ADR 044). An ack whose alpha-queue message still
 * exists is never deleted — the next digest cycle re-verifies its bytes.
 * Sweeps state/alpha-acks/ plus the legacy alpha-ack-* pattern in
 * state/research/; token dossiers never match the legacy pattern's
 * alpha-ack- prefix.
 */
export function retainAlphaAckTombstones(args: Readonly<{
  agentRoot: string
  maxAgeDays: number
  nowMs?: number
}>): string[] {
  if (!Number.isFinite(args.maxAgeDays) || args.maxAgeDays < 1) {
    throw new TypeError(`invalid maxAgeDays: ${args.maxAgeDays}`)
  }
  const agentRoot = resolve(args.agentRoot)
  const nowMs = args.nowMs ?? Date.now()
  const removed: string[] = []
  const sweeps: ReadonlyArray<readonly [string, RegExp]> = [
    [join(agentRoot, "state", "alpha-acks"), ACK_NAME_RE],
    [join(agentRoot, "state", "research"), LEGACY_ACK_NAME_RE],
  ]
  for (const [dir, namePattern] of sweeps) {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue
    for (const name of readdirSync(dir)) {
      if (name.includes("..") || name.includes("\0")) continue
      const match = namePattern.exec(name)
      if (!match) continue
      const channel = match[1]!
      const messageId = match[2]!
      if (channel.includes("..") || channel.includes("/")) continue
      const queuePath = join(agentRoot, "alpha-queue", channel, `${messageId}.json`)
      if (existsSync(queuePath)) continue
      const path = join(dir, name)
      if (!isOlderThan(path, args.maxAgeDays, nowMs)) continue
      rmSync(path, { force: true })
      removed.push(path)
    }
  }
  return removed
}

/**
 * Slugs present in state/narratives/log.jsonl. Returns null when the log
 * exists but cannot be read — callers must then skip the dossier sweep
 * (fail closed). Malformed lines are skipped, matching the host prune.
 */
function readNarrativeLogSlugs(agentRoot: string): Set<string> | null {
  const path = join(agentRoot, "state", "narratives", "log.jsonl")
  const slugs = new Set<string>()
  if (!existsSync(path)) return slugs
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return null
  }
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue
    try {
      const slug = (JSON.parse(line) as Record<string, unknown>)["slug"]
      if (typeof slug === "string" && slug.length > 0) slugs.add(slug)
    } catch {
      continue
    }
  }
  return slugs
}

/**
 * Delete narrative dossiers (state/narratives/<slug>.md) untouched for more
 * than maxAgeDays whose slug is absent from the narrative log (ADR 045).
 * Dossiers of active slugs survive at any age; log.jsonl never matches.
 */
export function retainNarrativeDossiers(args: Readonly<{
  agentRoot: string
  maxAgeDays: number
  nowMs?: number
}>): string[] {
  if (!Number.isFinite(args.maxAgeDays) || args.maxAgeDays < 1) {
    throw new TypeError(`invalid maxAgeDays: ${args.maxAgeDays}`)
  }
  const agentRoot = resolve(args.agentRoot)
  const nowMs = args.nowMs ?? Date.now()
  const removed: string[] = []
  const dir = join(agentRoot, "state", "narratives")
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return removed
  const activeSlugs = readNarrativeLogSlugs(agentRoot)
  if (activeSlugs === null) return removed
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue
    if (name.includes("..") || name.includes("\0")) continue
    const slug = name.slice(0, -".md".length)
    if (slug.length === 0 || activeSlugs.has(slug)) continue
    const path = join(dir, name)
    if (!isOlderThan(path, args.maxAgeDays, nowMs)) continue
    rmSync(path, { force: true })
    removed.push(path)
  }
  return removed
}

/**
 * Prune agent workspace inbox dirs, chat reports, purged alpha-ack tombstones,
 * and long-dormant narrative dossiers by age.
 * Never touches archive/ (content-addressed journal stays intact).
 */
export function retainWorkspaceArtifacts(args: Readonly<{
  agentRoot: string
  inboxMaxAgeDays: number
  chatReportsMaxAgeDays: number
  alphaAckMaxAgeDays: number
  narrativeDossierMaxAgeDays: number
  nowMs?: number
}>): WorkspaceRetentionReport {
  const agentRoot = resolve(args.agentRoot)
  const nowMs = args.nowMs ?? Date.now()
  const inboxDir = join(agentRoot, "inbox")
  const chatDir = join(agentRoot, "reports", "chat")

  // Belt-and-braces: refuse if agentRoot itself looks like an archive tree
  if (basename(agentRoot) === "archive" || agentRoot.includes("/archive/")) {
    throw new Error("refuse retention under archive/")
  }

  const inboxRemoved = retainByAge(inboxDir, args.inboxMaxAgeDays, nowMs, {
    expectedParent: agentRoot,
  })
  const chatReportsRemoved = retainByAge(chatDir, args.chatReportsMaxAgeDays, nowMs, {
    expectedParent: agentRoot,
  })
  const alphaAcksRemoved = retainAlphaAckTombstones({
    agentRoot,
    maxAgeDays: args.alphaAckMaxAgeDays,
    nowMs,
  })
  const narrativeDossiersRemoved = retainNarrativeDossiers({
    agentRoot,
    maxAgeDays: args.narrativeDossierMaxAgeDays,
    nowMs,
  })

  return {
    schema: 1,
    inboxRemoved,
    chatReportsRemoved,
    alphaAcksRemoved,
    narrativeDossiersRemoved,
    inboxMaxAgeDays: args.inboxMaxAgeDays,
    chatReportsMaxAgeDays: args.chatReportsMaxAgeDays,
    alphaAckMaxAgeDays: args.alphaAckMaxAgeDays,
    narrativeDossierMaxAgeDays: args.narrativeDossierMaxAgeDays,
  }
}
