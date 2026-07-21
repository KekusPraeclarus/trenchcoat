import { spawnSync } from "node:child_process"
import { existsSync, lstatSync } from "node:fs"
import { join } from "node:path"
import {
  classifyRemediationRisk,
  isAbsoluteDenyPath,
  isLowRiskPath,
  LOW_RISK_MAX_FILES,
  LOW_RISK_MAX_LINES,
} from "./risk.js"

function listChanged(worktreePath: string): string[] {
  const diff = spawnSync("git", ["diff", "--name-only", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
  })
  const staged = spawnSync("git", ["diff", "--name-only", "--cached"], {
    cwd: worktreePath,
    encoding: "utf8",
  })
  const untracked = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: worktreePath, encoding: "utf8" },
  )
  return [...new Set([
    ...(diff.stdout ?? "").split("\n"),
    ...(staged.stdout ?? "").split("\n"),
    ...(untracked.stdout ?? "").split("\n"),
  ].map((s) => s.trim()).filter(Boolean))]
}

function countChangedLines(worktreePath: string): number {
  const out = spawnSync("git", ["diff", "--numstat", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
  })
  let total = 0
  for (const line of (out.stdout ?? "").split("\n")) {
    const [added, removed] = line.trim().split("\t")
    if (!added || !removed || added === "-" || removed === "-") continue
    total += Number(added) + Number(removed)
  }
  return total
}

function isRegularFile(abs: string): boolean {
  if (!existsSync(abs)) return false
  const st = lstatSync(abs)
  return st.isFile() && !st.isSymbolicLink()
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//u, "").replace(/\\/gu, "/")
}

export function evaluateProposedPaths(args: Readonly<{
  paths: readonly string[]
  changedLineCount?: number
  typedMigration?: string
}>): { ok: boolean; violations: string[]; riskLevel: "low" | "high" | "deny" } {
  const violations: string[] = []
  const normalized = args.paths.map(normalizePath)
  for (const path of normalized) {
    if (path.includes("..") || path.startsWith("/") || path.includes("\0")) {
      violations.push(`traversal:${path}`)
    }
    if (isAbsoluteDenyPath(path)) {
      violations.push(`deny:${path}`)
    }
  }
  const risk = classifyRemediationRisk({
    paths: normalized,
    ...(args.changedLineCount !== undefined
      ? { changedLineCount: args.changedLineCount }
      : {}),
    ...(args.typedMigration ? { typedMigration: args.typedMigration } : {}),
  })
  if (risk.level === "deny") {
    violations.push(...risk.reasons)
  }
  return {
    ok: violations.length === 0 && risk.level !== "deny",
    violations,
    riskLevel: risk.level,
  }
}

export function evaluateWorktreeConfinement(args: Readonly<{
  worktreePath: string
  approvedPaths: readonly string[]
  requireLowRiskOnly?: boolean
}>): {
  ok: boolean
  violations: string[]
  changed: string[]
  changedLineCount: number
  riskLevel: "low" | "high" | "deny"
} {
  const changed = listChanged(args.worktreePath)
  const changedLineCount = countChangedLines(args.worktreePath)
  const approved = new Set(args.approvedPaths.map(normalizePath))
  const violations: string[] = []

  for (const path of changed) {
    const p = normalizePath(path)
    if (p.includes("..") || p.startsWith("/")) {
      violations.push(`traversal:${p}`)
      continue
    }
    const abs = join(args.worktreePath, p)
    if (existsSync(abs) && !isRegularFile(abs)) {
      violations.push(`symlink-or-nonfile:${p}`)
      continue
    }
    if (isAbsoluteDenyPath(p)) {
      violations.push(`deny:${p}`)
      continue
    }
    if (!approved.has(p)) {
      violations.push(`outside-approved:${p}`)
    }
    if (args.requireLowRiskOnly && !isLowRiskPath(p)) {
      violations.push(`not-low-risk:${p}`)
    }
  }

  if (changed.length > LOW_RISK_MAX_FILES && args.requireLowRiskOnly) {
    violations.push(`file-count:${changed.length}`)
  }
  if (changedLineCount > LOW_RISK_MAX_LINES && args.requireLowRiskOnly) {
    violations.push(`line-count:${changedLineCount}`)
  }

  const risk = classifyRemediationRisk({
    paths: changed,
    changedLineCount,
  })
  if (risk.level === "deny") {
    violations.push(...risk.reasons)
  }

  return {
    ok: violations.length === 0,
    violations,
    changed,
    changedLineCount,
    riskLevel: risk.level,
  }
}

export function pathsMateriallyExpanded(
  approved: readonly string[],
  actual: readonly string[],
): boolean {
  const allow = new Set(approved.map(normalizePath))
  return actual.some((p) => !allow.has(normalizePath(p)))
}
