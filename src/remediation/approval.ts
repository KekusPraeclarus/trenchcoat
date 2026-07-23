import { sha256Json } from "../lib/canonical-json.js"
import type { ApprovalAction, PatchProposal, RemediationIncident } from "./schemas.js"

export function proposalContentHash(proposal: PatchProposal): string {
  return sha256Json({
    schema: proposal.schema,
    summary: proposal.summary,
    paths: [...proposal.paths].sort(),
    perFileChanges: proposal.perFileChanges,
    tests: proposal.tests,
    invariants: proposal.invariants,
    docs: proposal.docs,
    typedMigration: proposal.typedMigration ?? null,
    rollout: proposal.rollout,
    smokeChecks: proposal.smokeChecks,
    rollback: proposal.rollback,
  })
}

export function approvalExpiryIso(
  nowIso: string,
  ttlHours: number,
): string {
  const ms = Date.parse(nowIso) + ttlHours * 3_600_000
  return new Date(ms).toISOString()
}

export function isApprovalExpired(
  incident: RemediationIncident,
  nowIso: string,
): boolean {
  if (!incident.approvalExpiresAt) return true
  return Date.parse(nowIso) > Date.parse(incident.approvalExpiresAt)
}

export type ApprovalDecision =
  | { ok: true; action: ApprovalAction; incident: RemediationIncident }
  | { ok: false; reason: string }

export function applyApprovalCommand(args: Readonly<{
  incident: RemediationIncident
  action: ApprovalAction
  operatorId: string
  proposalHash: string
  nowIso: string
}>): ApprovalDecision {
  if (args.incident.phase !== "awaiting-approval") {
    return { ok: false, reason: "not-awaiting-approval" }
  }
  if (!args.incident.proposalHash) {
    return { ok: false, reason: "missing-proposal-hash" }
  }
  if (args.incident.proposalHash !== args.proposalHash) {
    return { ok: false, reason: "proposal-hash-mismatch" }
  }
  if (isApprovalExpired(args.incident, args.nowIso)) {
    return { ok: false, reason: "approval-expired" }
  }
  if (args.incident.approvedAt) {
    return { ok: false, reason: "already-consumed" }
  }

  if (args.action === "approve") {
    return {
      ok: true,
      action: "approve",
      incident: {
        ...args.incident,
        phase: "approved",
        approvedAt: args.nowIso,
        approvedBy: args.operatorId,
        updatedAt: args.nowIso,
      },
    }
  }
  if (args.action === "defer") {
    return {
      ok: true,
      action: "defer",
      incident: {
        ...args.incident,
        phase: "deferred",
        deferredAt: args.nowIso,
        deferredReason: "operator-defer",
        approvedAt: args.nowIso,
        approvedBy: args.operatorId,
        updatedAt: args.nowIso,
      },
    }
  }
  return {
    ok: true,
    action: "reject",
    incident: {
      ...args.incident,
      phase: "rejected",
      approvedAt: args.nowIso,
      approvedBy: args.operatorId,
      terminalError: "operator-reject",
      updatedAt: args.nowIso,
    },
  }
}

/**
 * Normalize operator-typed incident ids so Telegram typos still hit the host
 * parser: `Rem 92da…`, `rem_92da…`, `REM-92da…` → `rem-92da…`.
 */
export function normalizeRemediationIncidentId(raw: string): string | null {
  const cleaned = raw.trim().replace(/^["'`]+|["'`]+$/gu, "")
  const exact = /^rem-([a-z0-9]{3,64})$/iu.exec(cleaned)
  if (exact?.[1]) return `rem-${exact[1]!.toLowerCase()}`
  const spaced = /^rem[\s_]+([a-z0-9]{3,64})$/iu.exec(cleaned)
  if (spaced?.[1]) return `rem-${spaced[1]!.toLowerCase()}`
  const embedded = /\brem[\s_-]+([a-z0-9]{8,64})\b/iu.exec(cleaned)
  if (embedded?.[1]) return `rem-${embedded[1]!.toLowerCase()}`
  return null
}

export function renderApprovalMessage(args: Readonly<{
  incident: RemediationIncident
  diagnosisSummary: string
  paths: readonly string[]
  tests: readonly string[]
  invariants: readonly string[]
  rollout: string
  rollback: string
  proposalSummary?: string
}>): string {
  const id = args.incident.incidentId
  const lines = [
    `Needs your approval — ${args.incident.riskLevel ?? "high"} risk remediation`,
    `Id: ${id}`,
    `Title: ${args.incident.title}`,
    "",
    `What happened: ${args.diagnosisSummary.slice(0, 400)}`,
    "",
    args.proposalSummary
      ? `Proposed fix: ${args.proposalSummary.slice(0, 400)}`
      : null,
    `Touches: ${args.paths.slice(0, 8).join(", ")}${args.paths.length > 8 ? ` (+${args.paths.length - 8} more)` : ""}`,
    `Tests: ${args.tests.join("; ").slice(0, 280) || "none listed"}`,
    `Rollout: ${args.rollout.slice(0, 220)}`,
    `Rollback: ${args.rollback.slice(0, 220)}`,
    "",
    `Expires: ${args.incident.approvalExpiresAt ?? "?"}`,
    `proposalHash: ${args.incident.proposalHash ?? "?"}`,
    "",
    "Reply with exactly one line (keep the hyphen in the id):",
    `approve remediation ${id}`,
    `defer remediation ${id}`,
    `reject remediation ${id}`,
  ].filter((line): line is string => line !== null)
  return lines.join("\n")
}

export function parseRemediationCommand(text: string): {
  action: ApprovalAction | "status" | "list"
  incidentId?: string
} | null {
  const trimmed = text.trim()
  if (/^\/?remediations$/iu.test(trimmed)) {
    return { action: "list" }
  }
  const actionCmd = /^(approve|defer|reject)\s+remediation\s+(.+)$/iu.exec(trimmed)
  if (actionCmd?.[1] && actionCmd[2]) {
    const incidentId = normalizeRemediationIncidentId(actionCmd[2])
    if (incidentId) {
      return {
        action: actionCmd[1].toLowerCase() as ApprovalAction,
        incidentId,
      }
    }
  }
  const status = /^\/?remediation\s+(.+)$/iu.exec(trimmed)
  if (status?.[1]) {
    const incidentId = normalizeRemediationIncidentId(status[1])
    if (incidentId) return { action: "status", incidentId }
  }
  return null
}

/** Bounded intent from general operator agent — host still revalidates. */
export function parseForwardedRemediationIntent(text: string): {
  action: ApprovalAction
  incidentId: string
} | null {
  const approve = /\bapprov(?:e|al|ed)\b[\s\S]{0,100}?\brem[\s_-]*([a-f0-9]{8,})\b/iu.exec(text)
  if (approve?.[1]) {
    return { action: "approve", incidentId: `rem-${approve[1].toLowerCase()}` }
  }
  const defer = /\bdefer(?:red|ral)?\b[\s\S]{0,100}?\brem[\s_-]*([a-f0-9]{8,})\b/iu.exec(text)
  if (defer?.[1]) {
    return { action: "defer", incidentId: `rem-${defer[1].toLowerCase()}` }
  }
  const reject = /\breject(?:ed|ion)?\b[\s\S]{0,100}?\brem[\s_-]*([a-f0-9]{8,})\b/iu.exec(text)
  if (reject?.[1]) {
    return { action: "reject", incidentId: `rem-${reject[1].toLowerCase()}` }
  }
  return null
}
