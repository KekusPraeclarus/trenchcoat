import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { relative, resolve } from "node:path"

const AGENT_PROTECTED_PATHS = [
  "state/sources.json",
  "state/source-lifecycle.json",
  "state/fc-source-lifecycle.json",
  "state/x-engagement.json",
  "state/x-bot-health.json",
  "state/fc-engagement.json",
  "state/ledger.json",
  "state/research-queue.json",
  "state/wallets.json",
  "state/watchlist.json",
  "state/scorecard.json",
  "state/decisions.md",
  "state/INDEX.md",
  "state/narratives/log.jsonl",
  "AGENTS.md",
] as const

export type IntegritySnapshot = Readonly<Record<string, Buffer | undefined>>

export function captureIntegritySnapshot(agentRoot: string): IntegritySnapshot {
  const entries: Array<[string, Buffer | undefined]> = AGENT_PROTECTED_PATHS.map((path) => {
    const absolute = resolve(agentRoot, path)
    return [path, existsSync(absolute) ? readFileSync(absolute) : undefined]
  })

  const skillsRoot = resolve(agentRoot, "skills")
  if (existsSync(skillsRoot)) {
    entries.push(["skills/", hashTreeMarker(skillsRoot)])
  }

  return Object.freeze(Object.fromEntries(entries))
}

export function assertAgentIntegrity(agentRoot: string, before: IntegritySnapshot): void {
  for (const [path, original] of Object.entries(before)) {
    if (path === "skills/") {
      const current = existsSync(resolve(agentRoot, "skills"))
        ? hashTreeMarker(resolve(agentRoot, "skills"))
        : undefined
      if (!sameBytes(original, current)) {
        throw new Error("Agent modified host-only path skills/")
      }
      continue
    }
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

function hashTreeMarker(root: string): Buffer {
  const parts: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = resolve(dir, name)
      const st = statSync(path)
      if (st.isDirectory()) walk(path)
      else parts.push(`${relative(root, path)}:${st.size}:${Math.trunc(st.mtimeMs)}`)
    }
  }
  walk(root)
  return Buffer.from(parts.join("\n"), "utf8")
}
