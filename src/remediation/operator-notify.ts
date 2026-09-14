import { runOneShotSession } from "../orchestrator/session.js"
import { renderApprovalMessage } from "./approval.js"
import { systemdUnitFromFinding } from "./live-recovery.js"
import { sanitizeSecretLike } from "./sanitize.js"
import type { RemediationIncident, SuggestionLedgerEntry } from "./schemas.js"

const DIGEST_MODEL = "composer-2.5"
const OPERATOR_NOTIFY_MAX = 1_600
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
  diagnose: "Diagnose",
  triage: "Triage",
  build: "Build",
  review: "Review",
  gates: "Gates / tests",
  publish: "Publish",
  deploy: "Deploy",
})

const KEEPALIVE_ROLE: Readonly<Record<string, string>> = Object.freeze({
  "trenchcoat-listener": "Discord and Telegram listener",
  "trenchcoat-channels": "Telegram channel listener",
  "trenchcoat-x-scan": "X scan listener",
  "trenchcoat-router": "Local router",
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

/** Outcomes worth one detailed line each in the operator digest */
const DETAILED_OUTCOMES: ReadonlySet<string> = Object.freeze(new Set([
  "queued",
  "queued-waiting",
  "built",
]))

/**
 * Split a ledger day into detailed entries and routine forming noise. Forming
 * entries never carry a decision yet, so the digest reports their count only.
 */
export function splitSuggestionDigestEntries(
  entries: readonly SuggestionLedgerEntry[],
): Readonly<{ detailed: readonly SuggestionLedgerEntry[]; formingCount: number }> {
  const detailed = entries.filter((e) => DETAILED_OUTCOMES.has(e.outcome))
  const formingCount = entries.filter((e) => e.outcome === "forming").length
  return { detailed, formingCount }
}

/** Deterministic operator-facing digest (no model). */
export function renderSuggestionDigestHost(args: Readonly<{
  day: string
  entries: readonly SuggestionLedgerEntry[]
}>): string {
  const { detailed, formingCount } = splitSuggestionDigestEntries(args.entries)
  const lines = [
    `Discord suggestions ${args.day} — ${detailed.length} noteworthy`,
    ...detailed.map(entryBlurb),
    ...(formingCount > 0 ? [`• Forming: ${formingCount} thread(s) still incomplete`] : []),
    "",
    "queued = admitted to remediation; waiting = capacity hold; forming = incomplete idea.",
  ]
  return clipMessage(lines.join("\n"), OPERATOR_NOTIFY_MAX)
}

function systemdStateFromTitle(title: string): string | undefined {
  return /state=([a-z]+)/u.exec(title)?.[1]
}

function keepaliveRole(unit: string): string {
  return KEEPALIVE_ROLE[unit] ?? `KeepAlive ${unit}`
}

function describeSystemdProblem(title: string): string | undefined {
  const unit = systemdUnitFromFinding(title)
  if (!unit) return undefined
  const state = systemdStateFromTitle(title)
  const role = keepaliveRole(unit)
  if (state === "activating") {
    return `${role} (\`${unit}\`) was still starting.`
  }
  if (state === "deactivating") {
    return `${role} (\`${unit}\`) was still stopping.`
  }
  if (state === "failed") {
    return `${role} (\`${unit}\`) is in state failed.`
  }
  if (state === "inactive") {
    return `${role} (\`${unit}\`) is inactive.`
  }
  if (state) {
    return `${role} (\`${unit}\`) is not active. systemd state is ${state}.`
  }
  return `${role} (\`${unit}\`) is not active.`
}

function describeProblem(title: string): string {
  return describeSystemdProblem(title) ?? clipLine(title, SUMMARY_MAX)
}

function systemdNextSteps(unit: string): string[] {
  return [
    "Run `ops/remote.sh health`.",
    `Run \`ops/remote.sh -- systemctl --user status ${unit}\`.`,
    `If the unit is failed, run \`ops/remote.sh -- systemctl --user restart ${unit}\`.`,
    `Then run \`ops/remote.sh -- journalctl --user -u ${unit} -n 80\`.`,
  ]
}

function closeOrRetrySteps(id: string): string[] {
  return [
    `To close this, run \`ops/remote.sh remediations fail ${id}\`.`,
    `To retry a code rem, run \`ops/remote.sh remediations retry ${id}\`.`,
  ]
}

function renderOperatorNote(args: Readonly<{
  headline: string
  body: readonly string[]
  nextSteps: readonly string[]
  incidentId: string
}>): string {
  const lines = [
    args.headline,
    "",
    ...args.body,
    "",
    "What to do now:",
    ...args.nextSteps.map((step, index) => `${index + 1}. ${step}`),
    "",
    `Id: \`${args.incidentId}\``,
  ]
  return clipMessage(lines.join("\n"), OPERATOR_NOTIFY_MAX)
}

function splitDetail(detail: string): Readonly<{ stage: string; rest: string }> {
  const trimmed = detail.trim()
  const stage = trimmed.split(":")[0]?.trim().toLowerCase() ?? ""
  const rest = trimmed.includes(":")
    ? trimmed.slice(trimmed.indexOf(":") + 1).trim()
    : trimmed
  return { stage, rest }
}

function explainRemediationFailure(args: Readonly<{
  incident: RemediationIncident
  detail: string
}>): Readonly<{
  headline: string
  body: readonly string[]
  nextSteps: readonly string[]
}> {
  const id = args.incident.incidentId
  const problem = describeProblem(args.incident.title)
  const unit = systemdUnitFromFinding(args.incident.title)
  const { stage, rest } = splitDetail(args.detail)
  const stageLabel = STAGE_HINT[stage] ?? (stage || "Remediation")

  if (/viable-without-affected-files/iu.test(args.detail)) {
    return {
      headline: "Remediation stopped. Diagnose named no files to change.",
      body: [
        problem,
        "Diagnose said a fix was viable but listed no repo files.",
        "That usually means a runtime issue, not a code bug.",
      ],
      nextSteps: [
        ...(unit ? systemdNextSteps(unit) : ["Run `ops/remote.sh health`."]),
        `If health is ok, close this. Run \`ops/remote.sh remediations fail ${id}\`.`,
        "Do not retry a code rem unless a repo file still needs a change.",
      ],
    }
  }
  if (/viable-without-paths/iu.test(args.detail)) {
    return {
      headline: "Remediation stopped. Propose named no files to change.",
      body: [
        problem,
        "Propose said a fix was viable but listed no repo paths.",
      ],
      nextSteps: [
        "Run `ops/remote.sh remediations status`.",
        ...closeOrRetrySteps(id),
      ],
    }
  }
  if (/session failed/iu.test(rest)) {
    return {
      headline: "Remediation stopped. The model session returned no usable output.",
      body: [
        problem,
        `${stageLabel} failed. This is a model or runtime glitch.`,
        "The idea was not rejected.",
      ],
      nextSteps: [
        "Wait until the rem lane is free.",
        `Then run \`ops/remote.sh remediations retry ${id}\`.`,
        `To close this, run \`ops/remote.sh remediations fail ${id}\`.`,
      ],
    }
  }
  if (/^not-viable:/iu.test(args.detail)) {
    return {
      headline: "Remediation closed. No safe bounded patch exists.",
      body: [
        problem,
        clipLine(args.detail.replace(/^not-viable:/iu, "").trim() || "not viable", 280),
      ],
      nextSteps: [
        "No code rem will run for this item.",
        "Run `ops/remote.sh health` if the original symptom remains.",
      ],
    }
  }
  if (/malformed|repair failed/iu.test(rest)) {
    return {
      headline: "Remediation stopped. Model output failed host JSON checks.",
      body: [problem, `${stageLabel} returned output the host could not validate.`],
      nextSteps: [
        `Retry later. Run \`ops/remote.sh remediations retry ${id}\`.`,
        `To close this, run \`ops/remote.sh remediations fail ${id}\`.`,
      ],
    }
  }
  if (/rollback-failed|health-rollback-failed/iu.test(args.detail)) {
    return {
      headline: "URGENT. Remediation rollback failed. Automation is halted.",
      body: [
        problem,
        "Deploy failed and the revert did not restore runtime.",
        clipLine(rest || args.detail, 200),
      ],
      nextSteps: [
        "Run `ops/remote.sh health`.",
        "Fix install or runtime first.",
        "Then run `ops/remote.sh remediations unhalt`.",
      ],
    }
  }
  if (/^gates-failed/iu.test(args.detail)) {
    return {
      headline: "Remediation stopped. Tests or gates failed.",
      body: [problem, `Failed gates: ${clipLine(rest || args.detail, 200)}`],
      nextSteps: [
        "Inspect the rem worktree gate log.",
        ...closeOrRetrySteps(id),
      ],
    }
  }
  return {
    headline: "Remediation did not complete.",
    body: [problem, `${stageLabel}: ${clipLine(rest || args.detail, 280)}`],
    nextSteps: [
      "Run `ops/remote.sh remediations status`.",
      ...closeOrRetrySteps(id),
    ],
  }
}

/** Deterministic operator-facing health finding (no model). */
export function renderRemediationFindingHost(args: Readonly<{
  incident: RemediationIncident
}>): string {
  const unit = systemdUnitFromFinding(args.incident.title)
  const problem = describeProblem(args.incident.title)
  const headline = unit
    ? `${keepaliveRole(unit)} is not healthy.`
    : "A health check failed."
  const meaning = unit
    ? "This is a runtime KeepAlive issue. A repo patch is not the first fix."
    : "The host triages this next."
  const nextSteps = unit
    ? [...systemdNextSteps(unit), "No Telegram reply is needed unless it stays down."]
    : [
      "Run `ops/remote.sh health`.",
      "Run `ops/remote.sh remediations status`.",
      "No Telegram reply is needed unless it stays down.",
    ]
  return renderOperatorNote({
    headline,
    body: [problem, meaning],
    nextSteps,
    incidentId: args.incident.incidentId,
  })
}

/** Deterministic operator-facing failure note (no model). */
export function renderRemediationFailureHost(args: Readonly<{
  incident: RemediationIncident
  detail: string
}>): string {
  const explained = explainRemediationFailure(args)
  return renderOperatorNote({
    ...explained,
    incidentId: args.incident.incidentId,
  })
}

export function renderRemediationPathDriftHost(args: Readonly<{
  incidentId: string
  files: readonly string[]
}>): string {
  const files = args.files.slice(0, 12).map((path) => `\`${path}\``).join(", ")
    || "unknown"
  return renderOperatorNote({
    headline: "Remediation changed extra files. A new approval is required.",
    body: [`New files: ${clipLine(files, 280)}`],
    nextSteps: [
      "Wait for the new approval card.",
      `Reply \`approve remediation ${args.incidentId}\` or \`reject remediation ${args.incidentId}\`.`,
      "Keep the hyphen in the id.",
    ],
    incidentId: args.incidentId,
  })
}

export function renderRemediationHaltedHost(args: Readonly<{
  incidentId: string
  reason: "rollback" | "health-rollback"
}>): string {
  const why = args.reason === "health-rollback"
    ? "Deploy health failed and the revert did not restore runtime."
    : "Deploy failed and the revert did not restore runtime."
  return renderOperatorNote({
    headline: "URGENT. Remediation rollback failed. Automation is halted.",
    body: [why, "No other remediations will run until you clear the halt."],
    nextSteps: [
      "Run `ops/remote.sh health`.",
      "Fix install or runtime first.",
      "Then run `ops/remote.sh remediations unhalt`.",
    ],
    incidentId: args.incidentId,
  })
}

export function renderRemediationRolledBackHost(args: Readonly<{
  incidentId: string
}>): string {
  return renderOperatorNote({
    headline: "Remediation rolled back after a deploy failure.",
    body: [
      "Runtime should be the previous commit.",
      "Automation is not halted.",
    ],
    nextSteps: [
      "Run `ops/remote.sh health`.",
      "If health is ok, no action.",
      `If you want another attempt, run \`ops/remote.sh remediations retry ${args.incidentId}\`.`,
    ],
    incidentId: args.incidentId,
  })
}

export function renderRemediationAttentionHost(args: Readonly<{
  incidentId: string
  detail: string
}>): string {
  return renderOperatorNote({
    headline: "Remediation needs operator attention after deploy.",
    body: [clipLine(args.detail, 280)],
    nextSteps: [
      "Run `ops/remote.sh remediations status`.",
      `To close this, run \`ops/remote.sh remediations fail ${args.incidentId}\`.`,
    ],
    incidentId: args.incidentId,
  })
}

export function renderRemediationCompletedHost(args: Readonly<{
  incidentId: string
  commit: string
  correctionCount?: number
}>): string {
  const corrections = args.correctionCount && args.correctionCount > 0
    ? `Public corrections sent: ${args.correctionCount}.`
    : "No public corrections."
  return renderOperatorNote({
    headline: "Remediation completed.",
    body: [`Commit \`${clipLine(args.commit, 40)}\`.`, corrections],
    nextSteps: [
      "No action unless health looks wrong.",
      "Run `ops/remote.sh health` to confirm.",
    ],
    incidentId: args.incidentId,
  })
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
      : args.kind === "remediation-failure"
        ? "Rewrite the host remediation note. Keep the same facts, next steps, and rem- ids."
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
      : args.kind === "remediation-failure"
        ? [
          "Keep the headline, the meaning, and every next-step command.",
          "Keep every rem-… incident id and trenchcoat-… unit name unchanged.",
          "Do not add Kind, Phase, or Raw detail fields.",
          "Max 1,500 characters.",
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
  if (args.kind === "remediation-failure") {
    if (/Kind:|Raw detail|Phase:/u.test(polished)) return args.hostText
    if (!polished.includes("What to do now")) return args.hostText
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
        formingCount: splitSuggestionDigestEntries(args.entries).formingCount,
        items: splitSuggestionDigestEntries(args.entries).detailed.map((e) => ({
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
  if (args.polish !== true) return hostText
  try {
    return await polishOperatorNote({
      repoRoot: args.repoRoot,
      kind: "remediation-failure",
      hostText,
      facts: {
        incidentId: args.incident.incidentId,
        title: clipLine(args.incident.title, SUMMARY_MAX),
        origin: args.incident.origin ?? null,
        detail: clipLine(args.detail, 280),
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
