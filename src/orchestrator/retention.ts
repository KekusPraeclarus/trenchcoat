import { readdirSync, statSync, rmSync } from "node:fs"
import { basename, join, resolve } from "node:path"

export type WorkspaceRetentionReport = Readonly<{
  schema: 1
  inboxRemoved: readonly string[]
  chatReportsRemoved: readonly string[]
  inboxMaxAgeDays: number
  chatReportsMaxAgeDays: number
}>

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
    const ageDays = (nowMs - st.mtimeMs) / 86_400_000
    if (ageDays > maxAgeDays) {
      rmSync(path, { recursive: true, force: true })
      removed.push(path)
    }
  }
  return removed
}

/**
 * Prune agent workspace inbox dirs and chat reports by age.
 * Never touches archive/ (content-addressed journal stays intact).
 */
export function retainWorkspaceArtifacts(args: Readonly<{
  agentRoot: string
  inboxMaxAgeDays: number
  chatReportsMaxAgeDays: number
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

  return {
    schema: 1,
    inboxRemoved,
    chatReportsRemoved,
    inboxMaxAgeDays: args.inboxMaxAgeDays,
    chatReportsMaxAgeDays: args.chatReportsMaxAgeDays,
  }
}
