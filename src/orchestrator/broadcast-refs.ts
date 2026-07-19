import { existsSync, lstatSync, readFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { RunManifestSchema } from "../contracts/schemas.js"
import { runArchiveDir, type ArchiveLayout } from "../lib/archive.js"

const TRAVERSAL = /(?:^|\/)\.\.(?:\/|$)|\/\/|^\//u

function resolveUnder(root: string, rel: string): string | undefined {
  const base = resolve(root)
  const full = resolve(base, rel)
  if (full !== base && !full.startsWith(base + sep)) return undefined
  return full
}

function isRegularNonSymlink(path: string): boolean {
  if (!existsSync(path)) return false
  const st = lstatSync(path)
  return st.isFile() && !st.isSymbolicLink()
}

function loadInboxManifest(
  layout: ArchiveLayout,
  runId: string,
): Record<string, string> | undefined {
  const path = join(runArchiveDir(layout, runId), "manifest.json")
  if (!existsSync(path) || !isRegularNonSymlink(path)) return undefined
  try {
    const parsed = RunManifestSchema.safeParse(JSON.parse(readFileSync(path, "utf8")))
    if (!parsed.success) return undefined
    return parsed.data.inboxManifest
  } catch {
    return undefined
  }
}

export type CanonicalizeRefsResult =
  | Readonly<{ ok: true; refs: readonly string[] }>
  | Readonly<{ ok: false; reason: string }>

/**
 * Validate proposal refs and canonicalize same-run inbox paths to sealed archive
 * references before eventId derivation. State refs stay as `state/…`.
 */
export function canonicalizeBroadcastRefs(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  runId: string
  refs: readonly string[]
}>): CanonicalizeRefsResult {
  if (new Set(args.refs).size !== args.refs.length) {
    return { ok: false, reason: "refs-duplicated" }
  }

  const inboxManifest = loadInboxManifest(args.layout, args.runId)
  const frozenInboxDir = join(runArchiveDir(args.layout, args.runId), "inbox")
  const out: string[] = []

  for (const ref of args.refs) {
    if (TRAVERSAL.test(ref) || ref.includes("\0")) {
      return { ok: false, reason: "ref-traversal" }
    }

    if (ref.startsWith("archive/")) {
      return { ok: false, reason: "ref-not-proposal-shape" }
    }

    if (ref.startsWith("state/")) {
      const full = resolveUnder(args.agentRoot, ref)
      if (!full || !isRegularNonSymlink(full)) {
        return { ok: false, reason: "ref-missing-or-mutable:state" }
      }
      out.push(ref)
      continue
    }

    const inboxMatch = /^inbox\/([^/]+)\/([^/]+)$/u.exec(ref)
    if (!inboxMatch) {
      return { ok: false, reason: "ref-unsupported" }
    }
    const refRunId = inboxMatch[1]!
    const fileName = inboxMatch[2]!
    if (refRunId !== args.runId) {
      return { ok: false, reason: "ref-cross-run" }
    }
    if (TRAVERSAL.test(fileName) || fileName.includes("\0") || fileName === "." || fileName === "..") {
      return { ok: false, reason: "ref-traversal" }
    }
    if (!inboxManifest || !(fileName in inboxManifest)) {
      return { ok: false, reason: "ref-not-frozen" }
    }
    const frozen = join(frozenInboxDir, fileName)
    if (!isRegularNonSymlink(frozen)) {
      return { ok: false, reason: "ref-missing-or-mutable:inbox" }
    }
    // Agent-side inbox remains mutable; durable events cite the sealed copy only
    out.push(`archive/runs/${args.runId}/inbox/${fileName}`)
  }

  return { ok: true, refs: out }
}
