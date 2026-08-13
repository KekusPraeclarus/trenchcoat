import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { writeAtomicFileFsync } from "../lib/fs-atomic.js"
import { WorkspaceLock } from "../lib/lock.js"
import { systemClock } from "../lib/clock.js"
import { loadConfig } from "../lib/config.js"
import { DEPLOYMENT_CONFIG_SCHEMA } from "../lib/deployment.js"
import { log } from "../lib/log.js"
import { telegramSendOperatorMessageChunks } from "../lib/telegram-bot.js"
import {
  hostValidateReview,
  hostValidateTriage,
  runBuildAgent,
  runDiagnoseAgent,
  runProposeAgent,
  runReviewAgent,
  runTriageAgent,
} from "./agents.js"
import {
  applyApprovalCommand,
  approvalExpiryIso,
  parseRemediationCommand,
  proposalContentHash,
} from "./approval.js"
import { evaluateProposedPaths, evaluateWorktreeConfinement, pathsMateriallyExpanded } from "./confinement.js"
import { runRemediationGates, runSmokeChecks, selectSmokeChecks } from "./gates.js"
import { decidePreReviewLoop } from "./pre-review-loop.js"
import {
  candidateToIncident,
  collectRemediationIntake,
} from "./intake.js"
import {
  incidentArtifactDir,
  remediationLayout,
  repoMutationLockPath,
} from "./paths.js"
import { classifyRemediationRisk } from "./risk.js"
import {
  assertCleanMain,
  commitRemediation,
  deployRemediation,
  fetchOriginMain,
  prepareRemediationWorktree,
  PublishError,
  pushAndFastForward,
  revertAndRedeploy,
  verifyDeployHealth,
} from "./publish.js"
import type {
  PatchProposal,
  RemediationIncident,
  RemediationPhase,
} from "./schemas.js"
import { ACTIVE_REMEDIATION_PHASES } from "./schemas.js"
import {
  appendRemediationJournal,
  attemptsToday,
  bumpAttempts,
  createRemediationStore,
  upsertIncident,
} from "./store.js"
import { runPostFixClaimAudit } from "./post-fix-audit.js"
import {
  clearPostBuildArtifacts,
  decideLiveRecovery,
  jobsForIncident,
  jobsForLogPath,
  liveHealthFromSnapshot,
  shouldReopenTerminal,
} from "./live-recovery.js"
import { runOneShotSession } from "../orchestrator/session.js"
import { type RevalidationSessionRunner } from "./revalidate.js"
import { buildHealthSnapshot } from "../orchestrator/health.js"

async function updateIncident(
  incidentId: string,
  patch: Partial<RemediationIncident>,
): Promise<RemediationIncident> {
  const layout = remediationLayout()
  const store = createRemediationStore(layout)
  const lock = new WorkspaceLock(layout.lock)
  if (!lock.tryAcquire()) throw new Error("remediation lock busy")
  try {
    let file = store.load()
    const prev = file.incidents.find((i) => i.incidentId === incidentId)
    if (!prev) throw new Error("incident missing")
    const next: RemediationIncident = {
      ...prev,
      ...patch,
      updatedAt: systemClock.nowIso(),
    }
    file = upsertIncident(file, next)
    const terminal = next.phase === "completed"
      || next.phase === "failed"
      || next.phase === "ignored"
      || next.phase === "rejected"
      || next.phase === "deferred"
      || next.phase === "rolled-back"
      || next.phase === "attention-required"
    if ((ACTIVE_REMEDIATION_PHASES as Set<string>).has(next.phase)) {
      file = { ...file, activeIncidentId: incidentId }
    }
    if (terminal && file.activeIncidentId === incidentId) {
      file = { ...file, activeIncidentId: null }
    }
    await store.save(file)
    if (terminal) {
      const { clearIntegrityHoldForIncident } = await import("./integrity-hold.js")
      await clearIntegrityHoldForIncident(incidentId)
    }
    return next
  } finally {
    lock.release()
  }
}

async function notifyOperator(text: string): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"]
  const operatorId = process.env["TELEGRAM_OPERATOR_ID"]
  if (!token || !operatorId) return
  try {
    await telegramSendOperatorMessageChunks(fetch, token, operatorId, text)
  } catch (error) {
    log.warn("remediation telegram notify failed", {
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function scanRemediationIncidents(args: Readonly<{
  repoRoot: string
}>): Promise<{
  scanned: number
  created: number
  suggestions?: Awaited<ReturnType<typeof import("./suggestions.js").scanDiscordSuggestions>>
}> {
  const config = loadConfig()
  const ir = config.incident_remediation
  if (!ir.enabled) return { scanned: 0, created: 0 }

  const layout = remediationLayout()
  const store = createRemediationStore(layout)
  const nowIso = systemClock.nowIso()
  const intake = await collectRemediationIntake({
    store,
    layout,
    nowIso,
    maxEvidenceBytes: ir.max_evidence_bytes,
  })
  await store.saveCursors(intake.cursors)

  let file = store.load()
  file = { ...file, lastScanAt: nowIso }
  let created = 0

  for (const candidate of intake.candidates) {
    const existingActive = store.findByFingerprint(candidate.fingerprint, true)
    if (existingActive) continue
    const existingAny = store.findByFingerprint(candidate.fingerprint, false)
    const candidateJobs = [
      ...(candidate.job ? [candidate.job] : []),
      ...candidate.evidence.flatMap((item) => item.path ? jobsForLogPath(item.path) : []),
    ]
    const uniqueJobs = [...new Set(candidateJobs)]
    const origin = candidate.component === "health"
      ? "health" as const
      : candidate.component === "log"
        ? "log" as const
        : candidate.component === "skip"
          ? "skip" as const
          : "other" as const
    if (existingAny && !shouldReopenTerminal({
      origin,
      phase: existingAny.phase,
      jobs: uniqueJobs.length > 0 ? uniqueJobs : jobsForIncident(existingAny),
      health: intake.liveHealth,
    })) {
      continue
    }

    const recovered = decideLiveRecovery({
      origin,
      jobs: uniqueJobs,
      health: intake.liveHealth,
    })
    if (recovered.kind === "ignore") continue

    const artDir = incidentArtifactDir(layout, candidate.incidentId)
    mkdirSync(artDir, { recursive: true, mode: 0o700 })
    const logSnapPath = join(artDir, "evidence-log.txt")
    const logLines = candidate.evidence.filter((item) => item.kind === "log-line")
    let evidence = candidate.evidence
    if (logLines.length > 0) {
      await writeAtomicFileFsync(
        logSnapPath,
        `${logLines.map((item) => item.summary).join("\n")}\n`,
        0o600,
      )
      evidence = candidate.evidence.map((item) =>
        item.kind === "log-line" ? { ...item, path: logSnapPath } : item,
      )
    }
    const evidenceIndex = join(artDir, "evidence-index.json")
    await writeAtomicFileFsync(
      evidenceIndex,
      `${JSON.stringify({
        schema: 1,
        trust: "host-derived",
        incidentId: candidate.incidentId,
        evidence,
        healthSummaryPath: intake.healthSummaryPath,
      }, null, 2)}\n`,
      0o600,
    )

    let incident = candidateToIncident({ ...candidate, evidence }, nowIso)
    if (candidate.deterministicIgnore) {
      incident = {
        ...incident,
        phase: "ignored",
        triageVerdict: "ignore",
        triageReason: candidate.deterministicIgnore,
      }
    }

    file = upsertIncident(file, incident)
    created += 1
    await appendRemediationJournal(layout, incident.incidentId, {
      event: "detected",
      fingerprint: incident.fingerprint,
    })

    if (incident.phase === "ignored") continue

    // Critical health findings: notify operator without waiting for build
    if (
      candidate.severity === "error"
      && (candidate.component === "health" || candidate.component === "systemd" || candidate.component === "discord")
    ) {
      await notifyOperator(
        `remediation finding ${incident.incidentId}: ${incident.title.slice(0, 200)}`,
      )
    }

    const triage = await runTriageAgent({
      repoRoot: args.repoRoot,
      evidenceIndexPath: evidenceIndex,
      model: ir.triage_model,
    })
    if (!triage.ok) {
      incident = {
        ...incident,
        phase: "deferred",
        deferredAt: nowIso,
        deferredReason: `triage-failed:${triage.reason}`,
        triageVerdict: "defer-weekly",
      }
      file = upsertIncident(file, incident)
      const deferred = store.loadDeferred()
      if (!deferred.incidentIds.includes(incident.incidentId)) {
        await store.saveDeferred({
          schema: 1,
          incidentIds: [...deferred.incidentIds, incident.incidentId].slice(0, 200),
        })
      }
      continue
    }

    const validated = hostValidateTriage(triage.result, {
      hasEvidence: candidate.evidence.length > 0,
      ...(candidate.deterministicIgnore
        ? { deterministicIgnore: candidate.deterministicIgnore }
        : {}),
    })
    await writeAtomicFileFsync(
      join(artDir, "triage.json"),
      `${JSON.stringify(validated, null, 2)}\n`,
      0o600,
    )

    if (validated.verdict === "ignore") {
      incident = {
        ...incident,
        phase: "ignored",
        triageVerdict: "ignore",
        triageReason: validated.reason,
      }
    } else if (validated.verdict === "defer-weekly") {
      incident = {
        ...incident,
        phase: "deferred",
        triageVerdict: "defer-weekly",
        triageReason: validated.reason,
        deferredAt: nowIso,
        deferredReason: validated.reason,
      }
      const deferred = store.loadDeferred()
      if (!deferred.incidentIds.includes(incident.incidentId)) {
        await store.saveDeferred({
          schema: 1,
          incidentIds: [...deferred.incidentIds, incident.incidentId].slice(0, 200),
        })
      }
    } else {
      incident = {
        ...incident,
        phase: "triaged",
        triageVerdict: "attention-now",
        triageReason: validated.reason,
      }
    }
    file = upsertIncident(file, incident)
  }

  await store.save(file)

  // Passive Discord suggestion scan (conversation-aware)
  let suggestions: Awaited<ReturnType<typeof import("./suggestions.js").scanDiscordSuggestions>> | undefined
  try {
    const { scanDiscordSuggestions } = await import("./suggestions.js")
    suggestions = await scanDiscordSuggestions({
      store,
      layout,
      repoRoot: args.repoRoot,
      nowIso,
    })
    await appendRemediationJournal(layout, "suggestions-scan", {
      event: "suggestions-scan",
      ...suggestions,
    })
    // Write artifacts for newly queued suggestion incidents
    const after = store.load()
    for (const incident of after.incidents) {
      if (incident.origin !== "discord-suggestion") continue
      if (incident.phase !== "triaged") continue
      const artDir = incidentArtifactDir(layout, incident.incidentId)
      mkdirSync(artDir, { recursive: true, mode: 0o700 })
      const evidenceIndex = join(artDir, "evidence-index.json")
      if (!existsSync(evidenceIndex)) {
        await writeAtomicFileFsync(
          evidenceIndex,
          `${JSON.stringify({
            schema: 1,
            trust: "host-derived",
            incidentId: incident.incidentId,
            origin: "discord-suggestion",
            evidencePaths: incident.evidencePaths,
            category: incident.suggestionCategory,
            extendsIncidentId: incident.extendsIncidentId,
            alternativesConsidered: incident.alternativesConsidered,
            recommendationRationale: incident.recommendationRationale,
          }, null, 2)}\n`,
          0o600,
        )
      }
      const triagePath = join(artDir, "triage.json")
      if (!existsSync(triagePath)) {
        await writeAtomicFileFsync(
          triagePath,
          `${JSON.stringify({
            schema: 1,
            verdict: "attention-now",
            reason: incident.triageReason ?? "discord-suggestion-formed",
            confidence: 1,
          }, null, 2)}\n`,
          0o600,
        )
      }
    }
    // Daily digest line
    const day = nowIso.slice(0, 10)
    const cursors = store.loadCursors()
    if (cursors.lastSuggestionDigestDay !== day) {
      const ledger = store.loadSuggestions()
      const todayEntries = ledger.entries.filter((e) => e.updatedAt.startsWith(day))
      const noteworthy = todayEntries.filter((e) =>
        e.outcome === "queued"
        || e.outcome === "forming"
        || e.outcome === "built"
        || e.outcome === "queued-waiting",
      )
      // Forming entries only add a count line, so they never wake a digest alone
      const hasDecision = noteworthy.some((e) => e.outcome !== "forming")
      if (hasDecision) {
        const { renderSuggestionDigest } = await import("./operator-notify.js")
        await notifyOperator(await renderSuggestionDigest({
          repoRoot: args.repoRoot,
          day,
          entries: noteworthy,
        }))
        await store.saveCursors({ ...cursors, lastSuggestionDigestDay: day })
      }
    }
  } catch (error) {
    log.warn("discord suggestion scan failed", {
      detail: error instanceof Error ? error.message : String(error),
    })
  }

  return {
    scanned: intake.candidates.length,
    created,
    ...(suggestions ? { suggestions } : {}),
  }
}

export async function runRemediationWorker(args: Readonly<{
  repoRoot: string
  incidentId?: string
  weekly?: boolean
}>): Promise<{ ok: boolean; detail?: string }> {
  const config = loadConfig()
  const ir = config.incident_remediation
  if (!ir.enabled) return { ok: false, detail: "disabled" }

  const layout = remediationLayout()
  const store = createRemediationStore(layout)
  const file0 = store.load()
  if (file0.automationHalted) {
    return { ok: false, detail: `automation-halted:${file0.automationHaltReason ?? ""}` }
  }

  const worker = new WorkspaceLock(layout.workerLock)
  if (!worker.tryAcquire()) return { ok: false, detail: "worker busy" }

  try {
    // Serialize against other repo writers at start of mutate-capable work
    const mutationProbe = new WorkspaceLock(repoMutationLockPath())
    const canMutate = mutationProbe.tryAcquire()
    if (canMutate) mutationProbe.release()
    else {
      return { ok: false, detail: "repo-mutation-lock-held" }
    }

    let file = store.load()
    let record = args.incidentId
      ? store.findById(args.incidentId)
      : file.activeIncidentId
        ? store.findById(file.activeIncidentId)
        : undefined

    if (args.weekly) {
      await scanRemediationIncidents({ repoRoot: args.repoRoot })
      const deferred = store.loadDeferred()
      const nextId = deferred.incidentIds[0]
      if (nextId) {
        const candidate = store.findById(nextId)
        if (candidate && (candidate.phase === "deferred" || candidate.phase === "triaged")) {
          record = candidate
        }
      }
      file = { ...store.load(), lastWeeklyAt: systemClock.nowIso() }
      await store.save(file)
    }

    if (!record) {
      // Prefer oldest attention-now / triaged / approved / resumable
      const resumable = store.load().incidents.find((i) =>
        (ACTIVE_REMEDIATION_PHASES as Set<string>).has(i.phase)
        && i.phase !== "awaiting-approval",
      )
      record = resumable
    }

    if (!record) {
      // After hourly scan, pick newly triaged attention-now
      await scanRemediationIncidents({ repoRoot: args.repoRoot })
      record = store.load().incidents.find((i) => i.phase === "triaged")
    }

    if (!record) return { ok: true, detail: "idle" }

    if (record.phase === "awaiting-approval") {
      return { ok: true, detail: "awaiting-approval" }
    }

    const nowIso = systemClock.nowIso()
    if (
      record.phase === "triaged"
      || record.phase === "approved"
      || record.phase === "deferred" && args.weekly
    ) {
      if (attemptsToday(store.load(), nowIso) >= ir.max_immediate_builds_per_utc_day
        && !args.weekly
        && record.phase !== "approved"
      ) {
        return { ok: false, detail: "daily-build-cap" }
      }
    }

    try {
      await runRemediationPhases({
        repoRoot: args.repoRoot,
        incident: record,
        weekly: Boolean(args.weekly),
      })
      return { ok: true }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log.error("remediation failed", { detail, incidentId: record.incidentId })
      await updateIncident(record.incidentId, {
        phase: "failed",
        terminalError: detail.slice(0, 500),
      })
      await appendRemediationJournal(layout, record.incidentId, {
        event: "failed",
        reason: detail.slice(0, 280),
      })
      {
        const { renderRemediationFailure } = await import("./operator-notify.js")
        await notifyOperator(await renderRemediationFailure({
          repoRoot: args.repoRoot,
          incident: record,
          detail,
        }))
      }
      return { ok: false, detail }
    }
  } finally {
    worker.release()
  }
}

async function runRemediationPhases(args: Readonly<{
  repoRoot: string
  incident: RemediationIncident
  weekly: boolean
}>): Promise<void> {
  const config = loadConfig()
  const ir = config.incident_remediation
  const layout = remediationLayout()
  const store = createRemediationStore(layout)
  const artDir = incidentArtifactDir(layout, args.incident.incidentId)
  mkdirSync(artDir, { recursive: true, mode: 0o700 })
  const archiveRoot = join(homedir(), ".trenchcoat", "archive")
  const agentRoot = join(homedir(), ".trenchcoat", "agent")

  let record = args.incident
  const setPhase = async (
    phase: RemediationPhase,
    patch: Partial<RemediationIncident> = {},
  ) => {
    record = await updateIncident(record.incidentId, { phase, ...patch })
    await appendRemediationJournal(layout, record.incidentId, { event: "phase", phase })
  }

  const evidenceIndex = join(artDir, "evidence-index.json")
  const triagePath = join(artDir, "triage.json")
  const diagnosisPath = join(artDir, "diagnosis.json")
  const proposalPath = join(artDir, "proposal.json")

  // Diagnose
  if (
    record.phase === "triaged"
    || record.phase === "diagnosing"
    || (args.weekly && record.phase === "deferred")
  ) {
    if (record.origin !== "discord-suggestion") {
      const snapshot = await buildHealthSnapshot({ agentRoot, archiveRoot })
      const recovered = decideLiveRecovery({
        origin: record.origin,
        jobs: jobsForIncident(record),
        health: liveHealthFromSnapshot(snapshot),
      })
      if (recovered.kind === "ignore") {
        await setPhase("ignored", {
          terminalError: recovered.reason,
          triageReason: recovered.reason,
        })
        return
      }
    }
    clearPostBuildArtifacts(artDir)
    await setPhase("diagnosing")
    const diag = await runDiagnoseAgent({
      repoRoot: args.repoRoot,
      evidenceIndexPath: evidenceIndex,
      triagePath,
      model: ir.diagnose_model,
    })
    if (!diag.ok) throw new Error(`diagnose:${diag.reason}`)
    await writeAtomicFileFsync(
      diagnosisPath,
      `${JSON.stringify(diag.report, null, 2)}\n`,
      0o600,
    )
    if (diag.report.viable === false) {
      const reason = (diag.report.notViableReason ?? "not-viable").slice(0, 500)
      await setPhase("ignored", {
        terminalError: `not-viable:${reason}`,
        triageReason: reason,
      })
      if (record.origin === "discord-suggestion") {
        const { markSuggestionNotViable } = await import("./suggestions.js")
        const ledger = markSuggestionNotViable(
          store.loadSuggestions(),
          record.incidentId,
          reason,
          systemClock.nowIso(),
        )
        await store.saveSuggestions(ledger)
      }
      return
    }
    if (diag.report.affectedFiles.length === 0) {
      throw new Error("diagnose:viable-without-affected-files")
    }
    await setPhase("diagnosed")
  }

  // Propose ↔ pre-review loop (auto-revise up to max_pre_review_revises)
  const maxPreReviewRevises = ir.max_pre_review_revises
  while (
    record.phase === "diagnosed"
    || record.phase === "proposing"
    || record.phase === "proposed"
    || record.phase === "pre-reviewing"
  ) {
    if (record.phase === "diagnosed" || record.phase === "proposing") {
      await setPhase("proposing")
      const priorReviewPath = join(artDir, "pre-review.json")
      const prop = await runProposeAgent({
        repoRoot: args.repoRoot,
        diagnosisPath,
        model: ir.propose_model,
        ...(existsSync(priorReviewPath) ? { priorReviewPath } : {}),
      })
      if (!prop.ok) throw new Error(`propose:${prop.reason}`)
      if (prop.proposal.viable === false) {
        const reason = (prop.proposal.notViableReason ?? "not-viable").slice(0, 500)
        await writeAtomicFileFsync(
          proposalPath,
          `${JSON.stringify(prop.proposal, null, 2)}\n`,
          0o600,
        )
        await setPhase("ignored", {
          terminalError: `not-viable:${reason}`,
        })
        if (record.origin === "discord-suggestion") {
          const { markSuggestionNotViable } = await import("./suggestions.js")
          const ledger = markSuggestionNotViable(
            store.loadSuggestions(),
            record.incidentId,
            reason,
            systemClock.nowIso(),
          )
          await store.saveSuggestions(ledger)
        }
        return
      }
      if (prop.proposal.paths.length === 0) {
        throw new Error("propose:viable-without-paths")
      }
      const confinement = evaluateProposedPaths({
        paths: prop.proposal.paths,
        ...(prop.proposal.typedMigration
          ? { typedMigration: prop.proposal.typedMigration }
          : {}),
      })
      if (!confinement.ok || confinement.riskLevel === "deny") {
        throw new Error(`proposal-deny:${confinement.violations.join(",")}`)
      }
      const risk = classifyRemediationRisk({
        paths: prop.proposal.paths,
        ...(prop.proposal.typedMigration
          ? { typedMigration: prop.proposal.typedMigration }
          : {}),
      })
      const hash = proposalContentHash(prop.proposal)
      await writeAtomicFileFsync(
        proposalPath,
        `${JSON.stringify(prop.proposal, null, 2)}\n`,
        0o600,
      )
      await setPhase("proposed", {
        riskLevel: risk.level,
        riskReasons: [...risk.reasons],
        proposalHash: hash,
        proposedPaths: [...prop.proposal.paths],
        smokeChecks: selectSmokeChecks(record.component, prop.proposal.smokeChecks),
      })
    }

    if (record.phase === "proposed" || record.phase === "pre-reviewing") {
      await setPhase("pre-reviewing")
      const review = await runReviewAgent({
        repoRoot: args.repoRoot,
        diagnosisPath,
        proposalPath,
        model: ir.review_model,
      })
      if (!review.ok) throw new Error(`pre-review:${review.reason}`)
      const validated = hostValidateReview(review.review)
      const preReviewPath = join(artDir, "pre-review.json")
      await writeAtomicFileFsync(
        preReviewPath,
        `${JSON.stringify(validated, null, 2)}\n`,
        0o600,
      )
      const loop = decidePreReviewLoop({
        decision: validated.decision,
        reviseCount: record.preReviewReviseCount ?? 0,
        maxRevises: maxPreReviewRevises,
      })
      if (loop.kind === "approve") {
        await setPhase("pre-reviewed")
        break
      }
      if (loop.kind === "fail") {
        throw new Error(loop.reason)
      }
      // Archive this revise round, then re-enter propose with priorPreReviewPath
      if (existsSync(proposalPath)) {
        await writeAtomicFileFsync(
          join(artDir, `proposal.revise-${loop.nextCount}.json`),
          readFileSync(proposalPath, "utf8"),
          0o600,
        )
      }
      await writeAtomicFileFsync(
        join(artDir, `pre-review.revise-${loop.nextCount}.json`),
        `${JSON.stringify(validated, null, 2)}\n`,
        0o600,
      )
      await appendRemediationJournal(layout, record.incidentId, {
        event: "pre-review-revise",
        round: loop.nextCount,
        max: maxPreReviewRevises,
      })
      await setPhase("diagnosed", {
        preReviewReviseCount: loop.nextCount,
        terminalError: undefined,
      })
    }
  }

  // Risk / approval gate
  if (record.phase === "pre-reviewed") {
    if (record.riskLevel === "high") {
      const nowIso = systemClock.nowIso()
      const expires = approvalExpiryIso(nowIso, ir.approval_ttl_hours)
      await setPhase("awaiting-approval", { approvalExpiresAt: expires })
      const proposal = JSON.parse(
        await import("node:fs").then((fs) => fs.readFileSync(proposalPath, "utf8")),
      ) as PatchProposal
      const diagnosis = JSON.parse(
        await import("node:fs").then((fs) => fs.readFileSync(diagnosisPath, "utf8")),
      ) as { rootCause?: string }
      const { renderRemediationApproval } = await import("./operator-notify.js")
      await notifyOperator(await renderRemediationApproval({
        repoRoot: args.repoRoot,
        incident: { ...record, approvalExpiresAt: expires, proposalHash: record.proposalHash },
        diagnosisSummary: diagnosis.rootCause ?? record.title,
        proposalSummary: proposal.summary,
        paths: proposal.paths,
        tests: proposal.tests,
        invariants: proposal.invariants,
        rollout: proposal.rollout,
        rollback: proposal.rollback,
      }))
      return
    }
    await setPhase("approved")
  }

  if (record.phase === "awaiting-approval") return

  // Build
  if (record.phase === "approved" || record.phase === "building") {
    const store = createRemediationStore(layout)
    let file = store.load()
    file = bumpAttempts(file, systemClock.nowIso())
    await store.save(file)

    await setPhase("building", { attemptCount: (record.attemptCount ?? 0) + 1 })
    const baseSha = assertCleanMain(args.repoRoot)
    fetchOriginMain(args.repoRoot)
    const origin = fetchOriginMain(args.repoRoot)
    if (origin !== baseSha) {
      // rebuild against new base once
      if ((record.originMoveRebuilds ?? 0) >= ir.max_origin_move_rebuilds) {
        throw new Error("origin-moved-cap")
      }
      await setPhase("building", {
        originMoveRebuilds: (record.originMoveRebuilds ?? 0) + 1,
        baseSha: origin,
      })
    }
    const effectiveBase = origin === baseSha ? baseSha : origin
    const { worktreePath, branch } = prepareRemediationWorktree({
      repoRoot: args.repoRoot,
      incidentId: record.incidentId,
      baseSha: effectiveBase,
    })
    const proposal = JSON.parse(
      await import("node:fs").then((fs) => fs.readFileSync(proposalPath, "utf8")),
    ) as PatchProposal
    const build = await runBuildAgent({
      worktreePath,
      proposalPath,
      approvedPaths: proposal.paths,
      model: ir.build_model,
    })
    if (!build.ok) throw new Error(`build:${build.reason}`)
    await setPhase("built", {
      baseSha: effectiveBase,
      branch,
      worktreePath,
      proposedPaths: [...proposal.paths],
    })
  }

  // Post-build review + confinement
  if (record.phase === "built" || record.phase === "post-reviewing") {
    await setPhase("post-reviewing")
    if (!record.worktreePath || !record.proposedPaths) {
      throw new Error("missing-worktree")
    }
    const confinement = evaluateWorktreeConfinement({
      worktreePath: record.worktreePath,
      approvedPaths: record.proposedPaths,
      requireLowRiskOnly: record.riskLevel === "low",
    })
    await writeAtomicFileFsync(
      join(artDir, "diff-summary.json"),
      `${JSON.stringify({
        schema: 1,
        changed: confinement.changed,
        changedLineCount: confinement.changedLineCount,
        violations: confinement.violations,
        riskLevel: confinement.riskLevel,
      }, null, 2)}\n`,
      0o600,
    )
    if (!confinement.ok || confinement.riskLevel === "deny") {
      throw new Error(`post-confine:${confinement.violations.join(",")}`)
    }
    if (pathsMateriallyExpanded(record.proposedPaths, confinement.changed)) {
      if (record.riskLevel === "high" || confinement.riskLevel === "high") {
        await setPhase("awaiting-approval", {
          approvalExpiresAt: approvalExpiryIso(
            systemClock.nowIso(),
            ir.approval_ttl_hours,
          ),
          proposedPaths: confinement.changed,
          riskLevel: "high",
        })
        await notifyOperator(
          `remediation ${record.incidentId} path drift — new approval required\n`
          + `files: ${confinement.changed.join(", ")}`,
        )
        return
      }
      throw new Error("path-drift")
    }
    const review = await runReviewAgent({
      repoRoot: record.worktreePath,
      diagnosisPath,
      proposalPath,
      diffSummaryPath: join(artDir, "diff-summary.json"),
      model: ir.review_model,
    })
    if (!review.ok) throw new Error(`post-review:${review.reason}`)
    const validated = hostValidateReview(review.review)
    await writeAtomicFileFsync(
      join(artDir, "post-review.json"),
      `${JSON.stringify(validated, null, 2)}\n`,
      0o600,
    )
    if (validated.decision !== "approve") {
      throw new Error(`post-review-${validated.decision}`)
    }
    await setPhase("post-reviewed")
  }

  // Gates
  if (record.phase === "post-reviewed" || record.phase === "gating") {
    await setPhase("gating")
    if (!record.worktreePath) throw new Error("missing-worktree")
    const gates = await runRemediationGates({
      worktreePath: record.worktreePath,
      artifactDir: artDir,
    })
    if (!gates.ok) throw new Error(`gates-failed:${gates.steps.filter((s) => !s.ok).map((s) => s.name).join(",")}`)
    await setPhase("gated")
  }

  // Publish
  if (record.phase === "gated" || record.phase === "publishing") {
    await setPhase("publishing")
    if (!record.worktreePath || !record.baseSha || !record.proposedPaths || !record.branch) {
      throw new Error("missing-publish-context")
    }
    const proposal = JSON.parse(
      await import("node:fs").then((fs) => fs.readFileSync(proposalPath, "utf8")),
    ) as PatchProposal
    let candidateSha: string
    try {
      candidateSha = commitRemediation({
        worktreePath: record.worktreePath,
        incidentId: record.incidentId,
        title: proposal.summary,
        paths: record.proposedPaths,
      })
    } catch (error) {
      if (error instanceof PublishError && error.code === "mutation-lock") {
        throw error
      }
      throw error
    }
    try {
      pushAndFastForward({
        repoRoot: args.repoRoot,
        worktreePath: record.worktreePath,
        baseSha: record.baseSha,
        candidateSha,
      })
    } catch (error) {
      if (error instanceof PublishError && error.code === "origin-moved") {
        if ((record.originMoveRebuilds ?? 0) >= ir.max_origin_move_rebuilds) {
          throw error
        }
        await setPhase("approved", {
          originMoveRebuilds: (record.originMoveRebuilds ?? 0) + 1,
          candidateSha: undefined,
          worktreePath: undefined,
          branch: undefined,
          baseSha: undefined,
        })
        return
      }
      throw error
    }
    await setPhase("deploying", { candidateSha })
  }

  // Deploy + verify
  if (record.phase === "deploying") {
    if (!record.candidateSha) throw new Error("missing-candidate")
    const deploy = await deployRemediation({
      repoRoot: args.repoRoot,
      archiveRoot,
      sourceCommit: record.candidateSha,
      incidentId: record.incidentId,
    })
    if (!deploy.ok) {
      await setPhase("rolling-back")
      const rb = revertAndRedeploy({
        repoRoot: args.repoRoot,
        candidateSha: record.candidateSha,
      })
      if (!rb.ok) {
        const store = createRemediationStore(layout)
        const file = store.load()
        await store.save({
          ...file,
          automationHalted: true,
          automationHaltReason: rb.detail ?? "rollback-failed",
          activeIncidentId: null,
        })
        await setPhase("failed", {
          terminalError: `rollback-failed:${rb.detail ?? ""}`.slice(0, 500),
        })
        await notifyOperator(
          `URGENT: remediation rollback failed for ${record.incidentId}. Automation halted.`,
        )
        throw new Error(`rollback-failed:${rb.detail ?? ""}`)
      }
      await setPhase("rolled-back", {
        terminalError: deploy.detail?.slice(0, 500),
      })
      await notifyOperator(
        `remediation ${record.incidentId} rolled back after deploy failure`,
      )
      return
    }

    const health = verifyDeployHealth({
      expectedCommit: record.candidateSha,
      expectedSchema: DEPLOYMENT_CONFIG_SCHEMA,
    })
    if (!health.ok) {
      await setPhase("rolling-back")
      const rb = revertAndRedeploy({
        repoRoot: args.repoRoot,
        candidateSha: record.candidateSha,
      })
      if (!rb.ok) {
        const store = createRemediationStore(layout)
        const file = store.load()
        await store.save({
          ...file,
          automationHalted: true,
          automationHaltReason: rb.detail ?? "health-rollback-failed",
          activeIncidentId: null,
        })
        await notifyOperator(
          `URGENT: remediation health rollback failed for ${record.incidentId}. Automation halted.`,
        )
        throw new Error(`health-rollback-failed:${rb.detail ?? ""}`)
      }
      await setPhase("rolled-back", { terminalError: health.detail })
      return
    }

    const smoke = runSmokeChecks({
      repoRoot: args.repoRoot,
      checks: record.smokeChecks ?? ["smoke:default"],
    })
    if (!smoke.ok) {
      await setPhase("rolling-back")
      revertAndRedeploy({
        repoRoot: args.repoRoot,
        candidateSha: record.candidateSha,
      })
      await setPhase("rolled-back", { terminalError: smoke.detail })
      return
    }

    await setPhase("deployed", { deployedAt: systemClock.nowIso() })
  }

  // Post-fix claim audit (INV-S28)
  if (
    record.phase === "deployed"
    || record.phase === "awaiting-recovery-data"
    || record.phase === "collecting-revalidation"
    || record.phase === "revalidating"
    || record.phase === "reconciling-state"
    || record.phase === "correcting"
  ) {
    const candidateSha = record.candidateSha
    if (!candidateSha) throw new Error("missing-candidate")
    const deployedAt = record.deployedAt ?? systemClock.nowIso()
    if (!record.deployedAt) {
      record = await updateIncident(record.incidentId, { deployedAt })
    }

    const agentRoot = join(homedir(), ".trenchcoat", "agent")
    const reval = ir.revalidation
    const evalModel = reval.evaluate_model
    const revModel = reval.review_model

    const runSession: RevalidationSessionRunner | undefined = reval.enabled
      ? async ({ prompt, message }) => {
        const isReview = prompt.includes("independently review")
        const session = await runOneShotSession({
          prompt: `${prompt}\n\n${message}`,
          cwd: args.repoRoot,
          model: isReview ? revModel : evalModel,
          sandbox: true,
          mode: "ask",
        })
        if (session.status !== "finished" || !session.text) {
          throw new Error(session.error ?? "revalidation session failed")
        }
        return session.text
      }
      : undefined

    await setPhase("awaiting-recovery-data")
    const store = createRemediationStore(layout)
    const audit = await runPostFixClaimAudit({
      layout,
      store,
      incident: record,
      agentRoot,
      archiveRoot,
      sourceCommit: candidateSha,
      deployedAt,
      config: {
        enabled: reval.enabled,
        requiredHealthyObservations: reval.required_healthy_observations,
        maxRounds: reval.max_rounds,
        maxWaitHours: reval.max_wait_hours,
        autoCorrect: reval.auto_correct,
      },
      ...(runSession ? { runSession } : {}),
    })

    if (audit.phase === "awaiting-recovery-data") {
      await setPhase("awaiting-recovery-data", {
        ...(audit.recoveryConfirmedAt
          ? { recoveryConfirmedAt: audit.recoveryConfirmedAt }
          : {}),
        ...(audit.revalidationRound !== undefined
          ? { revalidationRound: audit.revalidationRound }
          : record.revalidationRound !== undefined
            ? { revalidationRound: record.revalidationRound }
            : {}),
        ...(audit.detail ? { attentionReason: audit.detail } : {}),
      })
      return
    }

    if (audit.phase === "attention-required") {
      await setPhase("attention-required", {
        ...(audit.detail ? { attentionReason: audit.detail.slice(0, 500) } : {}),
        ...(audit.recoveryConfirmedAt
          ? { recoveryConfirmedAt: audit.recoveryConfirmedAt }
          : {}),
        ...(audit.revalidationRound !== undefined
          ? { revalidationRound: audit.revalidationRound }
          : {}),
      })
      await notifyOperator(
        `remediation ${record.incidentId} needs attention: ${audit.detail ?? "post-fix-audit"}`,
      )
      return
    }

    await setPhase("completed", {
      ...(audit.recoveryConfirmedAt
        ? { recoveryConfirmedAt: audit.recoveryConfirmedAt }
        : {}),
      ...(audit.correctionEventIds
        ? { correctionEventIds: audit.correctionEventIds }
        : {}),
      ...(audit.revalidationRound !== undefined
        ? { revalidationRound: audit.revalidationRound }
        : {}),
      ...(audit.detail ? { attentionReason: audit.detail } : {}),
    })
    if (record.origin === "discord-suggestion") {
      const { markSuggestionBuilt } = await import("./suggestions.js")
      const ledger = markSuggestionBuilt(
        store.loadSuggestions(),
        record.incidentId,
        systemClock.nowIso(),
      )
      await store.saveSuggestions(ledger)
    }
    const deferred = store.loadDeferred()
    await store.saveDeferred({
      schema: 1,
      incidentIds: deferred.incidentIds.filter((id) => id !== record.incidentId),
    })
    await notifyOperator(
      `remediation completed ${record.incidentId} @ ${candidateSha}`
        + (audit.correctionEventIds?.length
          ? ` corrections=${audit.correctionEventIds.length}`
          : ""),
    )
  }
}

export async function handleRemediationChatCommand(args: Readonly<{
  text: string
  operatorId: string
  repoRoot?: string
}>): Promise<string | null> {
  const parsed = parseRemediationCommand(args.text)
  if (!parsed) return null

  const layout = remediationLayout()
  const store = createRemediationStore(layout)
  const file = store.load()

  if (parsed.action === "list") {
    const pending = file.incidents.filter((i) => i.phase === "awaiting-approval")
    const deferred = store.loadDeferred().incidentIds.length
    const active = file.activeIncidentId ?? "none"
    const lines = [
      `remediations: active=${active} deferred=${deferred} pendingApprovals=${pending.length}`,
      ...pending.slice(0, 10).map((i) =>
        `- ${i.incidentId} ${i.title.slice(0, 80)} hash=${i.proposalHash ?? "?"}`
      ),
    ]
    return lines.join("\n")
  }

  if (!parsed.incidentId) return "missing incident id"
  const incident = store.findById(parsed.incidentId)
  if (!incident) return `unknown remediation ${parsed.incidentId}`

  if (parsed.action === "status") {
    return [
      `remediation ${incident.incidentId}`,
      `phase=${incident.phase}`,
      `risk=${incident.riskLevel ?? "?"}`,
      `title=${incident.title}`,
      `proposalHash=${incident.proposalHash ?? "?"}`,
      `expires=${incident.approvalExpiresAt ?? "?"}`,
    ].join("\n")
  }

  if (!incident.proposalHash) return "no proposal hash"
  const decision = applyApprovalCommand({
    incident,
    action: parsed.action,
    operatorId: args.operatorId,
    proposalHash: incident.proposalHash,
    nowIso: systemClock.nowIso(),
  })
  if (!decision.ok) return `rejected: ${decision.reason}`

  await updateIncident(incident.incidentId, decision.incident)
  await appendRemediationJournal(layout, incident.incidentId, {
    event: "approval",
    action: decision.action,
    operatorId: args.operatorId,
  })

  if (decision.action === "defer") {
    const deferred = store.loadDeferred()
    if (!deferred.incidentIds.includes(incident.incidentId)) {
      await store.saveDeferred({
        schema: 1,
        incidentIds: [...deferred.incidentIds, incident.incidentId],
      })
    }
  }

  if (decision.action === "approve" && args.repoRoot) {
    // Detached child so Telegram listener / CLI approve return without holding
    // the Node event loop for the whole build (ADR 030).
    const { spawn } = await import("node:child_process")
    const cliEntry = process.argv[1]
    if (cliEntry) {
      const child = spawn(
        process.execPath,
        [cliEntry, "remediations", "run", incident.incidentId],
        {
          detached: true,
          stdio: "ignore",
          cwd: args.repoRoot,
          env: process.env,
        },
      )
      child.unref()
    } else {
      void runRemediationWorker({
        repoRoot: args.repoRoot,
        incidentId: incident.incidentId,
      }).catch(() => undefined)
    }
  }

  return `remediation ${incident.incidentId} ${decision.action}d`
}

export function remediationStatusSummary(): Record<string, unknown> {
  const layout = remediationLayout()
  const store = createRemediationStore(layout)
  const file = store.load()
  const deferred = store.loadDeferred()
  const pending = file.incidents.filter((i) => i.phase === "awaiting-approval")
  return {
    enabled: (() => {
      try {
        return loadConfig().incident_remediation.enabled
      } catch {
        return false
      }
    })(),
    activeIncidentId: file.activeIncidentId,
    pendingApprovals: pending.length,
    deferredCount: deferred.incidentIds.length,
    lastScanAt: file.lastScanAt ?? null,
    lastWeeklyAt: file.lastWeeklyAt ?? null,
    automationHalted: file.automationHalted,
    automationHaltReason: file.automationHaltReason ?? null,
  }
}
