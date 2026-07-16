import { existsSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"

const AGENT_PROTECTED_PATHS = [
  "state/sources.json",
  "state/source-lifecycle.json",
  "state/x-engagement.json",
  "state/ledger.json",
  "state/research-queue.json",
  "AGENTS.md",
] as const

export type IntegritySnapshot = Readonly<Record<string, Buffer | undefined>>

export function captureIntegritySnapshot(agentRoot: string): IntegritySnapshot {
  return Object.freeze(Object.fromEntries(
    AGENT_PROTECTED_PATHS.map((path) => {
      const absolute = resolve(agentRoot, path)
      return [path, existsSync(absolute) ? readFileSync(absolute) : undefined]
    }),
  ))
}

export function assertAgentIntegrity(agentRoot: string, before: IntegritySnapshot): void {
  for (const [path, original] of Object.entries(before)) {
    const absolute = resolve(agentRoot, path)
    const current = existsSync(absolute) ? readFileSync(absolute) : undefined
    if (!sameBytes(original, current)) {
      throw new Error(`Agent modified host-only path ${path}`)
    }
  }
}

export function safeAgentPath(agentRoot: string, candidate: string): string {
  const absolute = resolve(agentRoot, candidate)
  const relativePath = relative(agentRoot, absolute)
  if (relativePath === "" || relativePath.startsWith("..") || resolve(agentRoot, relativePath) !== absolute) {
    throw new TypeError("Path escapes agent workspace")
  }
  return absolute
}

function sameBytes(left: Buffer | undefined, right: Buffer | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined && left.equals(right))
}
