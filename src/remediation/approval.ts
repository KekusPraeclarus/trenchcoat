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

export function renderApprovalMessage(args: Readonly<{
  incident: RemediationIncident
  diagnosisSummary: string
  paths: readonly string[]
  tests: readonly string[]
  invariants: readonly string[]
  rollout: string
  rollback: string
}>): string {
  const lines = [
    `remediation approval required: ${args.incident.incidentId}`,
    `severity: ${args.incident.severity}`,
    `title: ${args.incident.title}`,
    `risk: ${args.incident.riskLevel ?? "high"}`,
    `degradation: ${args.incident.component ?? args.incident.job ?? "unknown"}`,
    "",
    `diagnosis: ${args.diagnosisSummary.slice(0, 400)}`,
    "",
    `files: ${args.paths.join(", ")}`,
    `tests: ${args.tests.join("; ").slice(0, 300)}`,
    `invariants: ${args.invariants.join(", ") || "none listed"}`,
    `rollout: ${args.rollout.slice(0, 280)}`,
    `rollback: ${args.rollback.slice(0, 280)}`,
    "",
    `proposalHash: ${args.incident.proposalHash ?? "?"}`,
    `expires: ${args.incident.approvalExpiresAt ?? "?"}`,
    "",
    `approve remediation ${args.incident.incidentId}`,
    `defer remediation ${args.incident.incidentId}`,
    `reject remediation ${args.incident.incidentId}`,
  ]
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
  const status = /^\/?remediation\s+(\S+)$/iu.exec(trimmed)
  if (status?.[1]) return { action: "status", incidentId: status[1] }
  const approve = /^approve\s+remediation\s+(\S+)$/iu.exec(trimmed)
  if (approve?.[1]) return { action: "approve", incidentId: approve[1] }
  const defer = /^defer\s+remediation\s+(\S+)$/iu.exec(trimmed)
  if (defer?.[1]) return { action: "defer", incidentId: defer[1] }
  const reject = /^reject\s+remediation\s+(\S+)$/iu.exec(trimmed)
  if (reject?.[1]) return { action: "reject", incidentId: reject[1] }
  return null
}

/** Bounded intent from general operator agent — host still revalidates. */
export function parseForwardedRemediationIntent(text: string): {
  action: ApprovalAction
  incidentId: string
} | null {
  const m = /\b(approve|defer|reject)\b[\s\S]{0,40}?\b(rem-[a-f0-9]{8,})\b/iu.exec(text)
  if (!m) return null
  return {
    action: m[1]!.toLowerCase() as ApprovalAction,
    incidentId: m[2]!,
  }
}
