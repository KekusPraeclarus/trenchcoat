import type { RiskLevel } from "./schemas.js"

/** Paths that never auto-proceed without Telegram approval when matched. */
export const HIGH_RISK_PREFIXES = [
  "src/lib/config.ts",
  "src/migrations/",
  "config/",
  "src/collectors/social/",
  "src/collectors/farcaster/signer.ts",
  "src/orchestrator/session.ts",
  "src/orchestrator/integrity.ts",
  "src/orchestrator/verify.ts",
  "src/orchestrator/audit",
  "src/orchestrator/scorecard",
  "src/prompts/",
  "src/chat/",
  "src/router/",
  "src/harness/",
  "src/lib/lock.ts",
  "src/lib/deploy-pause.ts",
  "src/lib/deployment.ts",
  "ops/",
  "package.json",
  "pnpm-lock.yaml",
] as const

/** Absolute deny — remediation lane cannot mutate these even with approval. */
export const ABSOLUTE_DENY_PREFIXES = [
  ".env",
  "src/remediation/",
  "agent/",
  "archive/",
] as const

export const ABSOLUTE_DENY_EXACT = new Set([
  ".env",
  "pnpm-lock.yaml",
])

/** Low-risk unattended allowlist prefixes. */
export const LOW_RISK_PREFIXES = [
  "src/collectors/",
  "src/orchestrator/",
  "src/lib/",
  "tests/",
  "docs/",
] as const

export const LOW_RISK_MAX_FILES = 8
export const LOW_RISK_MAX_LINES = 400

const HIGH_RISK_ORCHESTRATOR_FILES = new Set([
  "src/orchestrator/session.ts",
  "src/orchestrator/integrity.ts",
  "src/orchestrator/verify.ts",
  "src/orchestrator/journal.ts",
  "src/orchestrator/journal-store.ts",
  "src/orchestrator/run.ts",
  "src/orchestrator/proposals.ts",
  "src/orchestrator/preconditions.ts",
  "src/orchestrator/exoneration.ts",
  "src/orchestrator/abandon.ts",
  "src/orchestrator/quarantine.ts",
])

const HIGH_RISK_LIB_FILES = new Set([
  "src/lib/config.ts",
  "src/lib/lock.ts",
  "src/lib/deploy-pause.ts",
  "src/lib/deployment.ts",
  "src/lib/canonical-json.ts",
  "src/lib/fs-atomic.ts",
])

function normalizePath(path: string): string {
  return path.replace(/^\.\//u, "").replace(/\\/gu, "/")
}

export function isAbsoluteDenyPath(path: string): boolean {
  const p = normalizePath(path)
  if (ABSOLUTE_DENY_EXACT.has(p)) return true
  if (p.startsWith(".env.") || p.includes("/.env")) return true
  return ABSOLUTE_DENY_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix))
}

export function isHighRiskPath(path: string): boolean {
  const p = normalizePath(path)
  if (isAbsoluteDenyPath(p)) return true
  if (HIGH_RISK_ORCHESTRATOR_FILES.has(p)) return true
  if (HIGH_RISK_LIB_FILES.has(p)) return true
  if (p.startsWith("src/orchestrator/audit") || p.startsWith("src/orchestrator/scorecard")) {
    return true
  }
  return HIGH_RISK_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix))
}

export function isLowRiskPath(path: string): boolean {
  const p = normalizePath(path)
  if (isHighRiskPath(p)) return false
  return LOW_RISK_PREFIXES.some((prefix) => p.startsWith(prefix))
}

export type RiskClassification = Readonly<{
  level: RiskLevel
  reasons: readonly string[]
}>

export function classifyRemediationRisk(args: Readonly<{
  paths: readonly string[]
  changedLineCount?: number
  typedMigration?: string
}>): RiskClassification {
  const reasons: string[] = []
  const paths = args.paths.map(normalizePath)

  for (const path of paths) {
    if (isAbsoluteDenyPath(path)) {
      reasons.push(`deny:${path}`)
    }
  }
  if (reasons.length > 0) {
    return { level: "deny", reasons }
  }

  if (args.typedMigration?.trim()) {
    reasons.push("typed-migration")
  }
  if (paths.length > LOW_RISK_MAX_FILES) {
    reasons.push(`file-count:${paths.length}`)
  }
  if ((args.changedLineCount ?? 0) > LOW_RISK_MAX_LINES) {
    reasons.push(`line-count:${args.changedLineCount}`)
  }

  for (const path of paths) {
    if (isHighRiskPath(path)) reasons.push(`high:${path}`)
    else if (!isLowRiskPath(path)) reasons.push(`outside-low-risk:${path}`)
  }

  if (reasons.length > 0) {
    return { level: "high", reasons }
  }
  return { level: "low", reasons: ["low-risk-allowlist"] }
}
