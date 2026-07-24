import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { sha256Json } from "../lib/canonical-json.js"
import {
  HarnessPlanSchema,
  PROTECTED_QUALITY_METRICS,
  type HarnessPlan,
} from "../contracts/schemas.js"
import { HARNESS_PLAN_PROMPT } from "../prompts/host.js"
import {
  runOneShotSession,
  type SessionOptions,
  type SessionResult,
} from "../orchestrator/session.js"
import { hypothesisDir, loadHypothesis, saveHypothesis } from "./propose.js"
import { extractJsonObject } from "./parse-json.js"
import { DECISION_POLICY_REL_PATH } from "./paths.js"
import { loadImproverConfig } from "./improver-config.js"

export type PlanSessionFn = (opts: SessionOptions) => Promise<SessionResult>

export type RunHarnessPlannerOpts = Readonly<{
  archiveRoot: string
  hypothesisId: string
  repoRoot: string
  model: string
  baseCommit: string
  developmentEpochId: string
  holdoutEpochId: string
  nowIso: string
  runSession?: PlanSessionFn
}>

export type PlanAgentResult =
  | Readonly<{ ok: true, plan: HarnessPlan, planHash: `sha256:${string}` }>
  | Readonly<{ ok: false, reason: string }>

function buildPlanPrompt(args: Readonly<{
  scorecardSummaryPath: string
  weaknessReportPath?: string
  keepSummaryPath?: string
  priorAttemptsPath?: string
  policyPath: string
  docsPaths: readonly string[]
  planAddendum?: string
}>): string {
  const lines = [
    HARNESS_PLAN_PROMPT,
    "",
    "Host-supplied paths only:",
    `scorecardSummary=${args.scorecardSummaryPath}`,
    ...(args.weaknessReportPath
      ? [`weaknessReport=${args.weaknessReportPath}`]
      : []),
    ...(args.keepSummaryPath ? [`keepSummary=${args.keepSummaryPath}`] : []),
    ...(args.priorAttemptsPath
      ? [`priorAttemptsSummary=${args.priorAttemptsPath}`]
      : []),
    `currentPolicy=${args.policyPath}`,
    ...args.docsPaths.map((p) => `doc=${p}`),
  ]
  if (args.planAddendum?.trim()) {
    lines.push("", `planAddendum=${args.planAddendum.trim().slice(0, 500)}`)
  }
  return lines.join("\n")
}

function parsePlan(
  text: string,
  defaults: Readonly<{
    hypothesisId: string
    createdAt: string
    model: string
    baseCommit: string
    developmentEpochId: string
    holdoutEpochId: string
    weaknessReportHash?: `sha256:${string}`
    keepSummaryHash?: `sha256:${string}`
  }>,
): HarnessPlan {
  const raw = extractJsonObject(text)
  const obj = typeof raw === "object" && raw !== null
    ? { ...raw as Record<string, unknown> }
    : {}
  const schema = obj["schema"] === 1 ? 1 : 2
  obj["schema"] = schema
  obj["hypothesisId"] = defaults.hypothesisId
  obj["createdAt"] = defaults.createdAt
  obj["model"] = defaults.model
  obj["baseCommit"] = defaults.baseCommit
  obj["developmentEpochId"] = defaults.developmentEpochId
  obj["holdoutEpochId"] = defaults.holdoutEpochId
  if (schema === 2 && defaults.weaknessReportHash) {
    obj["weaknessReportHash"] = defaults.weaknessReportHash
  }
  if (schema === 2 && defaults.keepSummaryHash) {
    obj["keepSummaryHash"] = defaults.keepSummaryHash
  }
  if (schema === 2 && !obj["expectedProtectedDirections"]) {
    const dirs: Record<string, string> = {}
    for (const m of PROTECTED_QUALITY_METRICS) dirs[m] = "hold"
    obj["expectedProtectedDirections"] = dirs
  }
  return HarnessPlanSchema.parse(obj)
}

export async function runHarnessPlanner(
  opts: RunHarnessPlannerOpts,
): Promise<PlanAgentResult> {
  const hypothesis = loadHypothesis(opts.archiveRoot, opts.hypothesisId)
  const dir = hypothesisDir(opts.archiveRoot, opts.hypothesisId)
  const scorecardSummaryPath = join(dir, "scorecard-summary.json")
  const weaknessReportPath = join(dir, "weakness-report.json")
  const keepSummaryPath = join(dir, "keep-summary.json")
  const priorAttemptsPath = join(dir, "prior-attempts-summary.json")
  const policyPath = join(opts.repoRoot, DECISION_POLICY_REL_PATH)
  const docsPaths = [
    join(opts.repoRoot, "docs/architecture/harness-improvement.md"),
    join(opts.repoRoot, "docs/INVARIANTS.md"),
  ]
  const improverConfig = loadImproverConfig(opts.repoRoot)

  const prompt = buildPlanPrompt({
    scorecardSummaryPath,
    ...(existsSync(weaknessReportPath) ? { weaknessReportPath } : {}),
    ...(existsSync(keepSummaryPath) ? { keepSummaryPath } : {}),
    ...(existsSync(priorAttemptsPath) ? { priorAttemptsPath } : {}),
    policyPath,
    docsPaths,
    planAddendum: improverConfig.planAddendum,
  })
  const runSession = opts.runSession ?? runOneShotSession
  const sessionOpts: SessionOptions = {
    prompt,
    cwd: opts.repoRoot,
    model: opts.model,
    sandbox: true,
    mode: "plan",
  }

  const defaults: {
    hypothesisId: string
    createdAt: string
    model: string
    baseCommit: string
    developmentEpochId: string
    holdoutEpochId: string
    weaknessReportHash?: `sha256:${string}`
    keepSummaryHash?: `sha256:${string}`
  } = {
    hypothesisId: opts.hypothesisId,
    createdAt: opts.nowIso,
    model: opts.model,
    baseCommit: opts.baseCommit,
    developmentEpochId: opts.developmentEpochId,
    holdoutEpochId: opts.holdoutEpochId,
  }
  if (hypothesis.weaknessReportHash) {
    defaults.weaknessReportHash = hypothesis.weaknessReportHash as `sha256:${string}`
  }
  if (hypothesis.keepSummaryHash) {
    defaults.keepSummaryHash = hypothesis.keepSummaryHash as `sha256:${string}`
  }

  let session = await runSession(sessionOpts)
  if (session.status !== "finished" || !session.text) {
    return { ok: false, reason: session.error ?? "planner session failed" }
  }

  let plan: HarnessPlan
  try {
    plan = parsePlan(session.text, defaults)
  } catch (firstError) {
    const repairPrompt = [
      prompt,
      "",
      "Previous output was malformed. Return one valid JSON plan object only (schema 2).",
      firstError instanceof Error ? firstError.message : String(firstError),
    ].join("\n")
    session = await runSession({ ...sessionOpts, prompt: repairPrompt })
    if (session.status !== "finished" || !session.text) {
      return { ok: false, reason: "planner repair session failed" }
    }
    try {
      plan = parsePlan(session.text, defaults)
    } catch (secondError) {
      return {
        ok: false,
        reason: secondError instanceof Error
          ? `planner malformed after repair: ${secondError.message}`
          : "planner malformed after repair",
      }
    }
  }

  if (plan.hypothesisId !== hypothesis.hypothesisId) {
    return { ok: false, reason: "plan hypothesisId mismatch" }
  }
  if (plan.primaryMetric !== hypothesis.primaryMetric) {
    return { ok: false, reason: "plan primaryMetric mismatch" }
  }

  await writeAtomicFile(
    join(dir, "plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
    0o600,
  )
  await saveHypothesis(opts.archiveRoot, { ...hypothesis, status: "planned" })
  const planHash = sha256Json(plan as never)
  return { ok: true, plan, planHash }
}

export function loadPlan(
  archiveRoot: string,
  hypothesisId: string,
): HarnessPlan {
  const path = join(hypothesisDir(archiveRoot, hypothesisId), "plan.json")
  return HarnessPlanSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}
