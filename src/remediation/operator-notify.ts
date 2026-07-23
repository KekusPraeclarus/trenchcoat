import { runOneShotSession } from "../orchestrator/session.js"
import { renderApprovalMessage } from "./approval.js"
import { sanitizeSecretLike } from "./sanitize.js"
import type { RemediationIncident, SuggestionLedgerEntry } from "./schemas.js"

const DIGEST_MODEL = "composer-2.5"
const OPERATOR_NOTIFY_MAX = 1_200
const SUMMARY_MAX = 160

const OUTCOME_LABEL: Readonly<Record<string, string>> = Object.freeze({
  queued: "Queued for build",
  "queued-waiting": "Waiting (capacity — max 1 active Discord suggestion)",
  forming: "Still forming (needs more Discord context)",
  built: "Built",
  "not-viable": "Closed as not viable",
})

const STAGE_HINT: Readonly<Record<string, string>> = Object.freeze({
  propose: "Propose (write a bounded patch plan from the diagnosis)",
  diagnose: "Diagnose (root-cause report)",
  triage: "Triage",
  build: "Build",
  review: "Review",
  gates: "Gates / tests",
  publish: "Publish",
  deploy: "Deploy",
})

function scrub(text: string): string {
  return sanitizeSecretLike(text).trim()
}

function clipLine(text: string, max: number): string {
  const cleaned = scrub(text).replace(/\s+/gu, " ")
  if ([...cleaned].length <= max) return cleaned
  return `${[...cleaned].slice(0, Math.max(0, max - 1)).join("")}…`
}

function clipMessage(text: string, max: number): string {
  const cleaned = scrub(text)
  if ([...cleaned].length <= max) return cleaned
  return `${[...cleaned].slice(0, Math.max(0, max - 1)).join("")}…`
}

function entryBlurb(entry: SuggestionLedgerEntry): string {
  const label = OUTCOME_LABEL[entry.outcome] ?? entry.outcome
  const body = entry.summary
    ?? entry.formingNote
    ?? entry.reason
    ?? entry.entryId
  const category = entry.category ? ` [${entry.category}]` : ""
  const id = entry.incidentId ? ` → ${entry.incidentId}` : ""
  return `• ${label}${category}: ${clipLine(body, SUMMARY_MAX)}${id}`
}

/** Deterministic operator-facing digest (no model). */
export function renderSuggestionDigestHost(args: Readonly<{
  day: string
  entries: readonly SuggestionLedgerEntry[]
}>): string {
  const lines = [
    `Discord suggestions ${args.day} — ${args.entries.length} noteworthy`,
    ...args.entries.map(entryBlurb),
    "",
    "queued = admitted to remediation; waiting = capacity hold; forming = incomplete idea.",
  ]
  return clipMessage(lines.join("\n"), OPERATOR_NOTIFY_MAX)
}

function explainFailureDetail(detail: string): string {
  const stage = detail.split(":")[0]?.trim().toLowerCase() ?? ""
  const rest = detail.includes(":")
    ? detail.slice(detail.indexOf(":") + 1).trim()
    : detail.trim()
  const stageLabel = STAGE_HINT[stage] ?? (stage || "unknown stage")

  if (/session failed/iu.test(rest)) {
    return `${stageLabel}: Cursor session returned no usable output (model/runtime glitch). The idea was not rejected — retry when the lane is free.`
  }
  if (/^not-viable:/iu.test(detail)) {
    return `Closed as not viable: ${clipLine(detail.replace(/^not-viable:/iu, ""), 280)}`
  }
  if (/malformed|repair failed/iu.test(rest)) {
    return `${stageLabel}: model output failed host JSON validation.`
  }
  return `${stageLabel}: ${clipLine(rest || detail, 280)}`
}

/** Deterministic operator-facing failure note (no model). */
export function renderRemediationFailureHost(args: Readonly<{
  incident: RemediationIncident
  detail: string
}>): string {
  const lines = [
    `Remediation failed ${args.incident.incidentId}`,
    `Title: ${clipLine(args.incident.title, SUMMARY_MAX)}`,
    `Origin: ${args.incident.origin ?? "unknown"}`,
    `Cause: ${explainFailureDetail(args.detail)}`,
    "",
    `Raw: ${clipLine(args.detail, 200)}`,
  ]
  return clipMessage(lines.join("\n"), OPERATOR_NOTIFY_MAX)
}

function stripFences(text: string): string {
  return text
    .replace(/^```(?:\w+)?\s*/u, "")
    .replace(/\s*```$/u, "")
    .trim()
}

async function polishOperatorNote(args: Readonly<{
  repoRoot: string
  kind: "suggestion-digest" | "remediation-failure" | "remediation-approval"
  hostText: string
  facts: Readonly<Record<string, unknown>>
  requireCommandLines?: readonly string[]
}>): Promise<string> {
  const prompt = [
    args.kind === "remediation-approval"
      ? "Rewrite the host remediation approval card into a short operator Telegram note in a clear first-person assistant voice (you are briefing the operator)."
      : "Rewrite the host operator note into a clearer Telegram message.",
    "Use ONLY the host facts JSON and host draft. Do not invent incidents, outcomes, paths, or causes.",
    "Plain text only. No markdown fences. No Discord quotes. No secrets or file contents.",
    args.kind === "remediation-approval"
      ? [
        "Lead with what broke and what the proposed fix does in plain language (2–4 short sentences).",
        "Mention risk level and that build starts only after exact approve.",
        "Keep every rem-… incident id unchanged.",
        "End by pasting the three exact command lines from the host draft VERBATIM (approve/defer/reject) — do not rephrase, wrap, or drop the hyphen.",
        "Max 1,100 characters including the command lines.",
      ].join(" ")
      : "Keep every incident id and outcome meaning. Max 900 characters.",
    "",
    `kind=${args.kind}`,
    `hostDraft=<<`,
    args.hostText,
    `>>`,
    `factsJson=${JSON.stringify(args.facts)}`,
  ].join("\n")

  const session = await runOneShotSession({
    prompt,
    cwd: args.repoRoot,
    model: DIGEST_MODEL,
    mode: "ask",
    sandbox: true,
    timeoutMs: 90_000,
  })
  if (session.status !== "finished" || !session.text) {
    return args.hostText
  }
  const polished = clipMessage(stripFences(session.text), OPERATOR_NOTIFY_MAX)
  if (polished.length < 40) return args.hostText
  const ids = args.hostText.match(/rem-[a-f0-9]{8,}/giu) ?? []
  for (const id of ids) {
    if (!polished.includes(id)) return args.hostText
  }
  if (args.requireCommandLines) {
    for (const line of args.requireCommandLines) {
      if (!polished.includes(line)) return args.hostText
    }
  }
  return polished
}

export async function renderSuggestionDigest(args: Readonly<{
  repoRoot: string
  day: string
  entries: readonly SuggestionLedgerEntry[]
  polish?: boolean
}>): Promise<string> {
  const hostText = renderSuggestionDigestHost({
    day: args.day,
    entries: args.entries,
  })
  if (args.polish === false) return hostText
  try {
    return await polishOperatorNote({
      repoRoot: args.repoRoot,
      kind: "suggestion-digest",
      hostText,
      facts: {
        day: args.day,
        items: args.entries.map((e) => ({
          outcome: e.outcome,
          label: OUTCOME_LABEL[e.outcome] ?? e.outcome,
          category: e.category ?? null,
          summary: e.summary ? clipLine(e.summary, SUMMARY_MAX) : null,
          formingNote: e.formingNote ? clipLine(e.formingNote, SUMMARY_MAX) : null,
          reason: e.reason ?? null,
          incidentId: e.incidentId ?? null,
        })),
      },
    })
  } catch {
    return hostText
  }
}

export async function renderRemediationFailure(args: Readonly<{
  repoRoot: string
  incident: RemediationIncident
  detail: string
  polish?: boolean
}>): Promise<string> {
  const hostText = renderRemediationFailureHost({
    incident: args.incident,
    detail: args.detail,
  })
  if (args.polish === false) return hostText
  try {
    return await polishOperatorNote({
      repoRoot: args.repoRoot,
      kind: "remediation-failure",
      hostText,
      facts: {
        incidentId: args.incident.incidentId,
        title: clipLine(args.incident.title, SUMMARY_MAX),
        origin: args.incident.origin ?? null,
        phase: args.incident.phase,
        detail: clipLine(args.detail, 280),
        explanation: explainFailureDetail(args.detail),
      },
    })
  } catch {
    return hostText
  }
}

/** Deterministic high-risk approval card (no model). */
export function renderRemediationApprovalHost(args: Readonly<{
  incident: RemediationIncident
  diagnosisSummary: string
  proposalSummary: string
  paths: readonly string[]
  tests: readonly string[]
  invariants: readonly string[]
  rollout: string
  rollback: string
}>): string {
  return renderApprovalMessage({
    incident: args.incident,
    diagnosisSummary: args.diagnosisSummary,
    proposalSummary: args.proposalSummary,
    paths: args.paths,
    tests: args.tests,
    invariants: args.invariants,
    rollout: args.rollout,
    rollback: args.rollback,
  })
}

export async function renderRemediationApproval(args: Readonly<{
  repoRoot: string
  incident: RemediationIncident
  diagnosisSummary: string
  proposalSummary: string
  paths: readonly string[]
  tests: readonly string[]
  invariants: readonly string[]
  rollout: string
  rollback: string
  polish?: boolean
}>): Promise<string> {
  const hostText = renderRemediationApprovalHost({
    incident: args.incident,
    diagnosisSummary: args.diagnosisSummary,
    proposalSummary: args.proposalSummary,
    paths: args.paths,
    tests: args.tests,
    invariants: args.invariants,
    rollout: args.rollout,
    rollback: args.rollback,
  })
  const id = args.incident.incidentId
  const commandLines = [
    `approve remediation ${id}`,
    `defer remediation ${id}`,
    `reject remediation ${id}`,
  ] as const
  if (args.polish === false) return hostText
  try {
    return await polishOperatorNote({
      repoRoot: args.repoRoot,
      kind: "remediation-approval",
      hostText,
      requireCommandLines: commandLines,
      facts: {
        incidentId: id,
        title: clipLine(args.incident.title, SUMMARY_MAX),
        risk: args.incident.riskLevel ?? "high",
        origin: args.incident.origin ?? null,
        diagnosis: clipLine(args.diagnosisSummary, 280),
        proposal: clipLine(args.proposalSummary, 280),
        paths: args.paths.slice(0, 12),
        tests: args.tests.slice(0, 8).map((t) => clipLine(t, 80)),
        invariants: args.invariants.slice(0, 8),
        rollout: clipLine(args.rollout, 160),
        rollback: clipLine(args.rollback, 160),
        expires: args.incident.approvalExpiresAt ?? null,
        proposalHash: args.incident.proposalHash ?? null,
        commands: [...commandLines],
      },
    })
  } catch {
    return hostText
  }
}
