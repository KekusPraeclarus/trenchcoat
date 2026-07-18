import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig, loadEnvSecrets, type TrenchcoatConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { systemClock } from "../lib/clock.js"
import {
  desiredFollowFids,
  registerFcDiscoveryCandidates,
  reviewFcSourceLifecycle,
} from "../sources/fc-lifecycle.js"
import type { SourceLifecycleThresholds } from "../sources/lifecycle.js"
import type { FcDiscoverySighting } from "./collect.js"
import { aggregateSourcePerformance, type SourceCallOutcome } from "../sources/outcomes.js"
import { syncFollowGraph } from "../collectors/farcaster/follow-sync.js"
import {
  assertFarcasterSignerReady,
  buildSignerGateReceipt,
  probeFarcasterSigner,
  signerMutationsAllowed,
  type FarcasterSignerGateReceipt,
} from "../collectors/farcaster/signer.js"
import type { FcFollowSyncReceipt, FcSourceLifecycleFile } from "../contracts/schemas.js"
import { loadSourceCallOutcomes } from "./sources.js"
import { archiveLayout } from "../lib/archive.js"

export function fcThresholdsFromConfig(config: TrenchcoatConfig): SourceLifecycleThresholds {
  return {
    max_transitions_per_review: config.farcaster.source_lifecycle.max_transitions_per_review,
    promotion: config.farcaster.source_lifecycle.promotion,
    demotion: config.farcaster.source_lifecycle.demotion,
  }
}

export function ingestFcDiscoverySightings(
  state: StateStore,
  sightings: readonly FcDiscoverySighting[],
  seenAt = systemClock.nowIso(),
): FcSourceLifecycleFile {
  const current = state.loadFcSourceLifecycle()
  return registerFcDiscoveryCandidates(current, sightings, seenAt)
}

export type FcSourceReviewOptions = Readonly<{
  agentRoot: string
  archiveRoot: string
  dryRun?: boolean
  sync?: boolean
  outcomes?: readonly SourceCallOutcome[]
  epochId?: string
  nowIso?: string
  blockExternalEffects?: boolean
}>

export type FcSourceReviewReport = Readonly<{
  epochId: string
  scoreCutoff: string
  applied: number
  queued: number
  pending: number
  managed: number
  candidates: number
  sync?: FcFollowSyncReceipt
  signerGate?: FarcasterSignerGateReceipt
  transitions: readonly {
    handle: string
    fid: number
    action: string
    reasonCode: string
  }[]
}>

export async function runFcSourceReview(
  opts: FcSourceReviewOptions,
): Promise<FcSourceReviewReport> {
  const config = loadConfig()
  const state = new StateStore(join(opts.agentRoot, "state"))
  const nowIso = opts.nowIso ?? systemClock.nowIso()
  const epochId = opts.epochId ?? `fc-source-review-${nowIso.slice(0, 10)}`
  const scoreCutoff = nowIso

  let file = state.loadFcSourceLifecycle()
  if (config.farcaster.bot_fid !== undefined) {
    file = { ...file, botFid: config.farcaster.bot_fid }
  }

  const outcomes = opts.outcomes ?? loadSourceCallOutcomes(archiveLayout(opts.archiveRoot))
  const performances = new Map(
    file.candidates.map((candidate) => [
      candidate.sourceId,
      aggregateSourcePerformance(
        candidate.sourceId,
        outcomes,
        scoreCutoff,
        config.audit.source_score_prior_strength,
      ),
    ]),
  )

  const reviewed = reviewFcSourceLifecycle({
    file,
    performances,
    epochId,
    nowIso,
    thresholds: fcThresholdsFromConfig(config),
    capacity: config.farcaster.follow_graph.capacity,
  })

  if (!opts.dryRun) {
    await state.saveFcSourceLifecycle(reviewed.file)
  }

  let sync: FcFollowSyncReceipt | undefined
  const shouldSync = opts.sync !== false
    && !opts.dryRun
    && !opts.blockExternalEffects
    && config.farcaster.enabled

  if (shouldSync) {
    const secrets = loadEnvSecrets()
    if (!secrets.neynarApiKey) throw new Error("NEYNAR_API_KEY required for FC follow sync")
    const probe = await probeFarcasterSigner({
      apiKey: secrets.neynarApiKey,
      nowIso,
    })
    const signerGate = buildSignerGateReceipt(probe)
    if (!signerMutationsAllowed(probe)) {
      const archiveDir = join(opts.archiveRoot, "fc-follow-sync", epochId)
      mkdirSync(archiveDir, { recursive: true })
      writeFileSync(
        join(archiveDir, "signer-gate.json"),
        `${JSON.stringify(signerGate, null, 2)}\n`,
      )
      return {
        epochId,
        scoreCutoff,
        applied: reviewed.applied.length,
        queued: reviewed.queued.length,
        pending: file.pendingTransitionIds.length,
        managed: file.candidates.filter((c) => c.status === "managed").length,
        candidates: file.candidates.length,
        signerGate,
        transitions: reviewed.applied.map((t) => ({
          handle: t.handle,
          fid: t.fid,
          action: t.action,
          reasonCode: t.reasonCode,
        })),
      }
    }

    const signer = assertFarcasterSignerReady()
    const botFid = config.farcaster.bot_fid ?? signer.fid
    const desired = desiredFollowFids(reviewed.file)
    const allowedFids = new Set(reviewed.file.candidates.map((c) => c.fid))
    sync = await syncFollowGraph({
      apiKey: secrets.neynarApiKey,
      signerUuid: signer.signerUuid,
      botFid,
      desiredFids: desired,
      allowedFids,
      nowIso,
    })

    if (sync.verified) {
      const cleared: FcSourceLifecycleFile = {
        ...reviewed.file,
        pendingTransitionIds: [],
      }
      await state.saveFcSourceLifecycle(cleared)
      file = cleared
    } else {
      file = reviewed.file
    }

    const archiveDir = join(opts.archiveRoot, "fc-follow-sync", epochId)
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(
      join(archiveDir, "receipt.json"),
      `${JSON.stringify(sync, null, 2)}\n`,
    )
  } else {
    file = reviewed.file
  }

  return {
    epochId,
    scoreCutoff,
    applied: reviewed.applied.length,
    queued: reviewed.queued.length,
    pending: file.pendingTransitionIds.length,
    managed: file.candidates.filter((c) => c.status === "managed").length,
    candidates: file.candidates.length,
    ...(sync ? { sync } : {}),
    transitions: reviewed.applied.map((t) => ({
      handle: t.handle,
      fid: t.fid,
      action: t.action,
      reasonCode: t.reasonCode,
    })),
  }
}

export async function syncFcFollowGraph(opts: Readonly<{
  agentRoot: string
  archiveRoot: string
  dryRun?: boolean
  nowIso?: string
  blockExternalEffects?: boolean
}>): Promise<FcFollowSyncReceipt> {
  const config = loadConfig()
  const state = new StateStore(join(opts.agentRoot, "state"))
  const nowIso = opts.nowIso ?? systemClock.nowIso()
  const epochId = `fc-follow-sync-${nowIso.replace(/[:.]/gu, "-")}`
  const file = state.loadFcSourceLifecycle()
  const secrets = loadEnvSecrets()
  if (!secrets.neynarApiKey) throw new Error("NEYNAR_API_KEY required for FC follow sync")
  if (!config.farcaster.enabled) throw new Error("farcaster.enabled is false")

  const probe = await probeFarcasterSigner({
    apiKey: secrets.neynarApiKey,
    nowIso,
  })
  const signerGate = buildSignerGateReceipt(probe)
  if (!opts.dryRun && !signerMutationsAllowed(probe)) {
    const archiveDir = join(opts.archiveRoot, "fc-follow-sync", epochId)
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(
      join(archiveDir, "signer-gate.json"),
      `${JSON.stringify(signerGate, null, 2)}\n`,
    )
    return {
      schema: 1,
      syncId: `sha256:${"0".repeat(64)}` as `sha256:${string}`,
      botFid: config.farcaster.bot_fid ?? probe.fid ?? 1,
      attemptedAt: nowIso,
      desiredFidsHash: `sha256:${"0".repeat(64)}` as `sha256:${string}`,
      followed: [],
      unfollowed: [],
      verified: false,
      ambiguous: true,
      error: `signer_gate_${probe.status}`,
    }
  }

  const signer = assertFarcasterSignerReady()
  const botFid = config.farcaster.bot_fid ?? signer.fid
  const desired = desiredFollowFids(file)
  const allowedFids = new Set(file.candidates.map((c) => c.fid))
  const receipt = await syncFollowGraph({
    apiKey: secrets.neynarApiKey,
    signerUuid: signer.signerUuid,
    botFid,
    desiredFids: desired,
    allowedFids,
    nowIso,
    dryRun: opts.dryRun === true || opts.blockExternalEffects === true,
  })

  if (!opts.dryRun && !opts.blockExternalEffects && receipt.verified) {
    await state.saveFcSourceLifecycle({
      ...file,
      pendingTransitionIds: [],
    })
  }

  const archiveDir = join(opts.archiveRoot, "fc-follow-sync", epochId)
  mkdirSync(archiveDir, { recursive: true })
  writeFileSync(join(archiveDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`)
  writeFileSync(join(archiveDir, "signer-gate.json"), `${JSON.stringify(signerGate, null, 2)}\n`)

  return receipt
}

export function probeFcSourceListSummary(agentRoot: string, config: TrenchcoatConfig): unknown {
  const state = new StateStore(join(agentRoot, "state"))
  const file = state.loadFcSourceLifecycle()
  return {
    enabled: config.farcaster.enabled,
    botFid: config.farcaster.bot_fid ?? file.botFid,
    capacity: config.farcaster.follow_graph.capacity,
    candidates: file.candidates.length,
    managed: file.candidates.filter((c) => c.status === "managed").length,
    probation: file.candidates.filter((c) => c.status === "probation").length,
    demoted: file.candidates.filter((c) => c.status === "demoted").length,
    pending: file.pendingTransitionIds.length,
    transitions: file.transitions.length,
  }
}
