/**
 * Post-deploy claim audit orchestration (INV-S28).
 * Called from runRemediationPhases after deploy health/smoke succeed.
 */

import { mkdirSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ensureArchive } from "../lib/archive.js"
import { systemClock } from "../lib/clock.js"
import { withAgentWorkspaceLock } from "../lib/lock.js"
import { writeAtomicFileFsync } from "../lib/fs-atomic.js"
import { Outbox } from "../lib/outbox.js"
import {
  claimsInImpactWindow,
  extractBroadcastClaimsFromArchive,
  loadMarketClaimIndex,
  saveMarketClaimIndex,
  upsertMarketClaim,
  type MarketClaimRecord,
} from "../orchestrator/market-claims.js"
import { pruneNarrativeLogInMemory, narrativeLogPath } from "../orchestrator/narrative-log.js"
import { buildCorrectionRouterEvent } from "../orchestrator/router.js"
import {
  buildCorrectionPayloads,
  claimsForDestination,
  correctionEventId,
  singleDiscordReplyTarget,
} from "./correction.js"
import { impactFromChangedPaths, mergeImpactScopes } from "./impact.js"
import {
  clearIntegrityHold,
  setIntegrityHold,
} from "./integrity-hold.js"
import { incidentArtifactDir, type RemediationLayout } from "./paths.js"
import { reconcileInvalidatedClaims } from "./reconcile.js"
import {
  assertEvidenceFetchedAfter,
  deterministicContradiction,
  hasDeterministicCheck,
  mergeVerdicts,
  runClaimEvaluator,
  runClaimReviewer,
  summarizeVerdicts,
  writeRevalidationArtifact,
  type RevalidationSessionRunner,
} from "./revalidate.js"
import type { ClaimRevalidationResult, RemediationIncident } from "./schemas.js"
import {
  computeImpactWindow,
  hasPostFixRecoveryProof,
  sourceKindsMissingFromLedger,
} from "./source-health.js"
import type { RemediationStore } from "./store.js"

export type PostFixAuditConfig = Readonly<{
  enabled: boolean
  requiredHealthyObservations: number
  maxRounds: number
  maxWaitHours: number
  autoCorrect: boolean
}>

export type PostFixAuditResult = Readonly<{
  phase:
    | "awaiting-recovery-data"
    | "attention-required"
    | "completed"
    | "correcting"
  detail?: string
  recoveryConfirmedAt?: string
  invalidated?: number
  correctionEventIds?: string[]
  revalidationRound?: number
}>

function loadNarrativeStage(
  agentRoot: string,
  slug: string,
): "emerging" | "peaking" | "fading" | undefined {
  const path = narrativeLogPath(agentRoot)
  if (!existsSync(path)) return undefined
  const { entries } = pruneNarrativeLogInMemory(
    readFileSync(path, "utf8"),
    new Date().toISOString(),
    3650,
  )
  return entries.find((e) => e.slug === slug)?.stage
}

function pastMaxWait(args: Readonly<{
  deployedAt: string
  maxWaitHours: number
  nowIso: string
}>): boolean {
  const deployedMs = Date.parse(args.deployedAt)
  const nowMs = Date.parse(args.nowIso)
  if (!Number.isFinite(deployedMs) || !Number.isFinite(nowMs)) return false
  return nowMs - deployedMs > args.maxWaitHours * 3_600_000
}

async function requireOperatorAttention(
  home: string | undefined,
  result: Omit<PostFixAuditResult, "phase"> & { detail: string },
): Promise<PostFixAuditResult> {
  await clearIntegrityHold(home)
  return { phase: "attention-required", ...result }
}

export async function runPostFixClaimAudit(args: Readonly<{
  layout: RemediationLayout
  store: RemediationStore
  incident: RemediationIncident
  agentRoot: string
  archiveRoot: string
  config: PostFixAuditConfig
  sourceCommit: string
  deployedAt: string
  runSession?: RevalidationSessionRunner
  home?: string
  providerMessageIds?: Readonly<Record<string, string>>
}>): Promise<PostFixAuditResult> {
  if (!args.config.enabled) {
    return { phase: "completed", detail: "revalidation-disabled" }
  }

  const proposedPaths = args.incident.proposedPaths ?? []
  const hostImpact = impactFromChangedPaths(proposedPaths)
  const impact = mergeImpactScopes(hostImpact, {
    ...(args.incident.affectedSources
      ? { sources: args.incident.affectedSources }
      : {}),
    ...(args.incident.affectedJobs
      ? { jobs: args.incident.affectedJobs }
      : {}),
  })

  if (impact.unknownMarketImpact && impact.sources.length === 0) {
    return requireOperatorAttention(args.home, { detail: "unknown-market-impact" })
  }

  const sources = impact.sources.length > 0
    ? impact.sources
    : (args.incident.affectedSources ?? [])
  if (sources.length === 0) {
    return { phase: "completed", detail: "no-market-sources" }
  }

  const nowIso = systemClock.nowIso()
  const ledger = args.store.loadSourceHealthLedger()
  const missingKinds = sourceKindsMissingFromLedger(ledger.observations, sources)
  if (sources.length > 0 && missingKinds.length === sources.length) {
    return requireOperatorAttention(args.home, {
      detail: `no-source-health-observations:${missingKinds.join(",")}`,
    })
  }

  await setIntegrityHold({
    schema: 1,
    incidentId: args.incident.incidentId,
    affectedSources: [...sources],
    affectedJobs: [...(impact.jobs.length > 0 ? impact.jobs : ["list-scan", "narrative-scan"])],
    heldAt: args.deployedAt,
    reason: "awaiting-post-fix-revalidation",
  }, args.home)

  if ((args.incident.correctionEventIds?.length ?? 0) > 0) {
    await clearIntegrityHold(args.home)
    return { phase: "completed", detail: "already-corrected" }
  }

  const recovery = hasPostFixRecoveryProof({
    observations: ledger.observations,
    sourceKinds: sources,
    deployedAt: args.deployedAt,
    sourceCommit: args.sourceCommit,
    requiredHealthy: args.config.requiredHealthyObservations,
  })

  if (!recovery.ok || !recovery.recoveryConfirmedAt) {
    if (pastMaxWait({
      deployedAt: args.deployedAt,
      maxWaitHours: args.config.maxWaitHours,
      nowIso,
    })) {
      return requireOperatorAttention(args.home, {
        detail: `recovery-wait-exhausted:${recovery.reason ?? "no-proof"}`,
      })
    }
    return {
      phase: "awaiting-recovery-data",
      ...(recovery.reason ? { detail: recovery.reason } : {}),
    }
  }

  const window = computeImpactWindow({
    observations: ledger.observations,
    sourceKinds: sources,
    recoveryConfirmedAt: recovery.recoveryConfirmedAt,
  })
  if (!window.ok || !window.startExclusive || !window.endInclusive) {
    return requireOperatorAttention(args.home, {
      detail: window.reason ?? "impact-window-unknown",
    })
  }

  const archiveLayout = await ensureArchive(args.archiveRoot)
  const fromArchive = extractBroadcastClaimsFromArchive({
    layout: archiveLayout,
    startExclusive: window.startExclusive,
    endInclusive: window.endInclusive,
  })
  let index = loadMarketClaimIndex(args.agentRoot)
  for (const claim of fromArchive) {
    index = upsertMarketClaim(index, claim)
  }
  await withAgentWorkspaceLock(args.agentRoot, async () => {
    await saveMarketClaimIndex(args.agentRoot, index)
  })

  const windowClaims = claimsInImpactWindow({
    claims: index.claims,
    startExclusive: window.startExclusive,
    endInclusive: window.endInclusive,
  })

  if (windowClaims.length === 0) {
    await clearIntegrityHold(args.home)
    return {
      phase: "completed",
      detail: "no-claims-in-window",
      recoveryConfirmedAt: recovery.recoveryConfirmedAt,
    }
  }

  const artDir = incidentArtifactDir(args.layout, args.incident.incidentId)
  mkdirSync(artDir, { recursive: true, mode: 0o700 })

  const allowlisted: string[] = []
  const evidenceBits: string[] = []
  for (const obs of ledger.observations) {
    if (obs.status !== "healthy") continue
    if (!sources.includes(obs.sourceKind)) continue
    if (obs.sourceCommit !== args.sourceCommit) continue
    if (Date.parse(obs.observedAt) <= Date.parse(args.deployedAt)) continue
    if (obs.runId) {
      const inboxDir = join(archiveLayout.runs, obs.runId, "inbox")
      if (existsSync(inboxDir)) allowlisted.push(inboxDir)
    }
    evidenceBits.push(
      `obs=${obs.observationId} kind=${obs.sourceKind} status=${obs.status} posts=${obs.postCount ?? 0} at=${obs.observedAt}`,
    )
  }

  const statusPaths = allowlisted
    .map((p) => join(p, "collection-status.json"))
    .filter((p) => existsSync(p))
  if (statusPaths.length > 0) {
    const freshness = assertEvidenceFetchedAfter(statusPaths, args.deployedAt)
    if (!freshness.ok) {
      return {
        phase: "awaiting-recovery-data",
        detail: freshness.reason,
        recoveryConfirmedAt: recovery.recoveryConfirmedAt,
      }
    }
  }

  const allowlistSet = new Set([
    ...allowlisted,
    ...evidenceBits,
    ...windowClaims.flatMap((c) => c.refs),
  ])

  const results: ClaimRevalidationResult[] = []
  const runSession = args.runSession

  for (const claim of windowClaims) {
    const stage = loadNarrativeStage(args.agentRoot, claim.subject)
    const det = deterministicContradiction({
      claim,
      ...(stage ? { currentNarrativeStage: stage } : {}),
    })

    if (!runSession) {
      results.push({
        schema: 1,
        claimId: claim.claimId,
        verdict: "inconclusive",
        reason: "no-revalidation-session",
        evidenceRefs: [],
        uncertainty: ["no-session"],
      })
      continue
    }

    const evaluator = await runClaimEvaluator({
      claim,
      allowlistedEvidence: [...allowlistSet].slice(0, 64),
      evidenceDigest: evidenceBits.join("\n"),
      runSession,
    })
    if (!evaluator.ok) {
      results.push({
        schema: 1,
        claimId: claim.claimId,
        verdict: "inconclusive",
        reason: `evaluator:${evaluator.reason}`,
        evidenceRefs: [],
        uncertainty: ["evaluator-failed"],
      })
      continue
    }
    const reviewer = await runClaimReviewer({
      claim,
      evaluator: evaluator.result,
      allowlistedEvidence: [...allowlistSet].slice(0, 64),
      evidenceDigest: evidenceBits.join("\n"),
      runSession,
    })
    if (!reviewer.ok) {
      results.push({
        schema: 1,
        claimId: claim.claimId,
        verdict: "inconclusive",
        reason: `reviewer:${reviewer.reason}`,
        evidenceRefs: [],
        uncertainty: ["reviewer-failed"],
      })
      continue
    }
    results.push(mergeVerdicts({
      claimId: claim.claimId,
      evaluator: evaluator.result,
      reviewer: reviewer.result,
      deterministicInvalidated: det,
      deterministicAvailable: hasDeterministicCheck(claim),
      allowlist: allowlistSet,
    }))
  }

  await writeRevalidationArtifact({ artifactDir: artDir, results })
  const summary = summarizeVerdicts(results)
  const round = (args.incident.revalidationRound ?? 0) + 1

  if (summary.inconclusive > 0 && summary.invalidated === 0 && summary.stands < windowClaims.length) {
    if (round >= args.config.maxRounds) {
      return requireOperatorAttention(args.home, {
        detail: `inconclusive-exhausted-rounds:${round}`,
        recoveryConfirmedAt: recovery.recoveryConfirmedAt,
        revalidationRound: round,
      })
    }
    if (pastMaxWait({
      deployedAt: args.deployedAt,
      maxWaitHours: args.config.maxWaitHours,
      nowIso,
    })) {
      return requireOperatorAttention(args.home, {
        detail: "inconclusive-wait-exhausted",
        recoveryConfirmedAt: recovery.recoveryConfirmedAt,
        revalidationRound: round,
      })
    }
    return {
      phase: "awaiting-recovery-data",
      detail: `inconclusive-retry-round:${round}`,
      recoveryConfirmedAt: recovery.recoveryConfirmedAt,
      revalidationRound: round,
    }
  }

  const reconcile = await withAgentWorkspaceLock(args.agentRoot, async () =>
    reconcileInvalidatedClaims({
      agentRoot: args.agentRoot,
      incidentId: args.incident.incidentId,
      nowIso,
      claims: windowClaims,
      results,
    }),
  )
  await writeAtomicFileFsync(
    join(artDir, "reconcile.json"),
    `${JSON.stringify(reconcile, null, 2)}\n`,
    0o600,
  )

  if (reconcile.attentionRequired) {
    return requireOperatorAttention(args.home, {
      detail: reconcile.attentionReason ?? "reconcile-failed",
      recoveryConfirmedAt: recovery.recoveryConfirmedAt,
      revalidationRound: round,
    })
  }

  if (summary.invalidated === 0 || !args.config.autoCorrect) {
    await clearIntegrityHold(args.home)
    return {
      phase: "completed",
      detail: summary.invalidated === 0 ? "all-claims-stand" : "auto-correct-disabled",
      recoveryConfirmedAt: recovery.recoveryConfirmedAt,
      invalidated: summary.invalidated,
      revalidationRound: round,
    }
  }

  const invalidatedIds = new Set(
    results.filter((r) => r.verdict === "invalidated").map((r) => r.claimId),
  )
  // Public correction only for invalidated finding.broadcast claims that
  // originally reached a destination — never for internal-only state.
  const publicTg = claimsForDestination({
    claims: windowClaims,
    invalidatedIds,
    destination: "telegram",
  })
  const publicDc = claimsForDestination({
    claims: windowClaims,
    invalidatedIds,
    destination: "discord",
  })

  if (publicTg.length === 0 && publicDc.length === 0) {
    await clearIntegrityHold(args.home)
    return {
      phase: "completed",
      detail: "invalidated-internal-only",
      recoveryConfirmedAt: recovery.recoveryConfirmedAt,
      invalidated: summary.invalidated,
      revalidationRound: round,
    }
  }

  const recoveredSource = sources.join("+")
  const payloads = buildCorrectionPayloads({
    telegramClaims: publicTg,
    discordClaims: publicDc,
    results,
    recoveredSource,
  })

  const runId = `remediation-${args.incident.incidentId}`
  const outbox = new Outbox(join(archiveLayout.routerOutbox, runId))
  const allPublic: MarketClaimRecord[] = [
    ...new Map(
      [...publicTg, ...publicDc].map((c) => [c.claimId, c] as const),
    ).values(),
  ]
  const eventId = correctionEventId({
    incidentId: args.incident.incidentId,
    destination: publicTg.length > 0 ? "telegram" : "discord",
    claimIds: allPublic.map((c) => c.claimId),
  })
  const replyTo = publicDc.length === 1
    ? singleDiscordReplyTarget({
      claims: publicDc,
      ...(args.providerMessageIds ? { providerMessageIds: args.providerMessageIds } : {}),
    })
    : undefined

  const channels: {
    telegram?: { text: string }
    discord?: { text: string }
  } = {
    ...(publicTg.length > 0 ? { telegram: payloads.telegram } : {}),
    ...(publicDc.length > 0 ? { discord: payloads.discord } : {}),
  }
  const event = buildCorrectionRouterEvent({
    runId,
    occurredAt: nowIso,
    eventId,
    text: (channels.telegram?.text ?? channels.discord?.text ?? payloads.telegram.text)
      .slice(0, 8_000),
    refs: ["state/market-claim-validity.json"],
    incidentId: args.incident.incidentId,
    invalidatedClaimIds: allPublic.map((c) => c.claimId),
    originalEventIds: allPublic
      .map((c) => c.eventId)
      .filter((id): id is string => Boolean(id)),
    ...(replyTo ? { replyToProviderMessageId: replyTo } : {}),
    channels,
  })
  await outbox.stage(event)

  await clearIntegrityHold(args.home)
  return {
    phase: "completed",
    detail: "corrected",
    recoveryConfirmedAt: recovery.recoveryConfirmedAt,
    invalidated: summary.invalidated,
    correctionEventIds: [eventId],
    revalidationRound: round,
  }
}
