import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig, loadEnvSecrets, type TrenchcoatConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { systemClock } from "../lib/clock.js"
import {
  parseFcEngagementProposal,
  applyFcEngagementChoices,
  fcLikesInWindow,
} from "../social/fc-engagement.js"
import type { EngagementCaps } from "../social/x-engagement.js"
import { executeFcEngagementActions } from "../collectors/farcaster/engagement.js"
import {
  assertFarcasterSignerReady,
  buildSignerGateReceipt,
  probeFarcasterSigner,
  signerMutationsAllowed,
  type FarcasterSignerGateReceipt,
} from "../collectors/farcaster/signer.js"
import type {
  FcEngagementDecision,
  FcEngagementFile,
  FcEngagementReceipt,
} from "../contracts/schemas.js"

export function fcEngagementCapsFromConfig(config: TrenchcoatConfig): EngagementCaps {
  return config.farcaster.engagement
}

export type FcEngagementRunReport = Readonly<{
  proposed: number
  accepted: number
  rejected: number
  executed: number
  verified: number
  ambiguous: number
  dryRun: boolean
  blockedExternalEffects: boolean
  signerGate?: FarcasterSignerGateReceipt
  decisions: readonly FcEngagementDecision[]
  receipts: readonly FcEngagementReceipt[]
  malformed?: "json" | "schema" | "run-id-mismatch"
}>

export async function processFarcasterScanEngagement(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  runId: string
  dryRun?: boolean
  execute?: boolean
  blockExternalEffects?: boolean
  nowIso?: string
  fypCasts?: readonly Readonly<{ hash: string, author: string, text?: string }>[]
}>): Promise<FcEngagementRunReport> {
  const config = loadConfig()
  const caps = fcEngagementCapsFromConfig(config)
  const nowIso = args.nowIso ?? systemClock.nowIso()
  const state = new StateStore(join(args.agentRoot, "state"))
  const proposalPath = join(args.agentRoot, "reports", args.runId, "fc-engagement.json")

  if (!existsSync(proposalPath) || !caps.enabled || !config.farcaster.enabled) {
    return emptyReport(Boolean(args.dryRun), Boolean(args.blockExternalEffects))
  }

  let proposalRaw: unknown
  try {
    proposalRaw = JSON.parse(readFileSync(proposalPath, "utf8"))
  } catch {
    return { ...emptyReport(Boolean(args.dryRun), Boolean(args.blockExternalEffects)), malformed: "json" }
  }

  let proposal
  try {
    proposal = parseFcEngagementProposal(proposalRaw)
  } catch {
    return { ...emptyReport(Boolean(args.dryRun), Boolean(args.blockExternalEffects)), malformed: "schema" }
  }

  if (proposal.runId !== args.runId) {
    return {
      ...emptyReport(Boolean(args.dryRun), Boolean(args.blockExternalEffects)),
      malformed: "run-id-mismatch",
    }
  }

  const current = state.loadFcEngagement()
  const fypCastHashes = (args.fypCasts ?? []).map((c) => c.hash)
  const applied = applyFcEngagementChoices({
    proposal,
    state: current,
    caps,
    nowIso,
    fypCastHashes,
  })

  if (args.dryRun) {
    return {
      proposed: proposal.items.length,
      accepted: applied.accepted.length,
      rejected: applied.rejected.length,
      executed: 0,
      verified: 0,
      ambiguous: 0,
      dryRun: true,
      blockedExternalEffects: Boolean(args.blockExternalEffects),
      decisions: applied.decisions,
      receipts: [],
    }
  }

  await state.saveFcEngagement(applied.nextState)

  let receipts: readonly FcEngagementReceipt[] = []
  let verifiedActionIds: readonly `sha256:${string}`[] = []
  let ambiguousActionIds: readonly `sha256:${string}`[] = []

  const externalEffectsBlocked = args.blockExternalEffects === true
  let signerGate: FarcasterSignerGateReceipt | undefined
  if (!externalEffectsBlocked && args.execute !== false && applied.accepted.length > 0) {
    const secrets = loadEnvSecrets()
    if (!secrets.neynarApiKey) throw new Error("NEYNAR_API_KEY required for FC engagement")
    const probe = await probeFarcasterSigner({
      apiKey: secrets.neynarApiKey,
      nowIso,
    })
    signerGate = buildSignerGateReceipt(probe)
    if (!signerMutationsAllowed(probe)) {
      const archiveDir = join(args.archiveRoot, "fc-engagement", args.runId)
      mkdirSync(archiveDir, { recursive: true })
      writeFileSync(
        join(archiveDir, "signer-gate.json"),
        `${JSON.stringify(signerGate, null, 2)}\n`,
      )
      writeFileSync(
        join(archiveDir, "decisions.json"),
        `${JSON.stringify(applied.decisions, null, 2)}\n`,
      )
      writeFileSync(join(archiveDir, "receipts.json"), "[]\n")
      return {
        proposed: proposal.items.length,
        accepted: applied.accepted.length,
        rejected: applied.rejected.length,
        executed: 0,
        verified: 0,
        ambiguous: applied.accepted.length,
        dryRun: false,
        blockedExternalEffects: false,
        signerGate,
        decisions: applied.decisions,
        receipts: [],
      }
    }

    const signer = assertFarcasterSignerReady()
    const executed = await executeFcEngagementActions({
      accepted: applied.accepted,
      nowIso,
      apiKey: secrets.neynarApiKey,
      signerUuid: signer.signerUuid,
    })
    receipts = executed.receipts
    verifiedActionIds = executed.verifiedActionIds
    ambiguousActionIds = executed.ambiguousActionIds

    const after = state.loadFcEngagement()
    const liked = new Set(after.likedCastHashes.map((h) => h.toLowerCase()))
    const lastLikedAt = { ...after.lastLikedAt }
    const verifiedSet = new Set(verifiedActionIds)

    for (const decision of applied.accepted) {
      if (!verifiedSet.has(decision.actionId as `sha256:${string}`)) continue
      liked.add(decision.target.toLowerCase())
      lastLikedAt[decision.target] = nowIso
    }

    const next: FcEngagementFile = {
      ...after,
      likedCastHashes: [...liked].sort(),
      lastLikedAt,
      receipts: [...after.receipts, ...receipts],
      pendingActionIds: after.pendingActionIds.filter((id) => (
        !verifiedActionIds.includes(id as `sha256:${string}`)
      )),
    }
    await state.saveFcEngagement(next)
  }

  const archiveDir = join(args.archiveRoot, "fc-engagement", args.runId)
  mkdirSync(archiveDir, { recursive: true })
  writeFileSync(
    join(archiveDir, "decisions.json"),
    `${JSON.stringify(applied.decisions, null, 2)}\n`,
  )
  writeFileSync(
    join(archiveDir, "receipts.json"),
    `${JSON.stringify(receipts, null, 2)}\n`,
  )

  return {
    proposed: proposal.items.length,
    accepted: applied.accepted.length,
    rejected: applied.rejected.length,
    executed: receipts.length,
    verified: verifiedActionIds.length,
    ambiguous: ambiguousActionIds.length,
    dryRun: false,
    blockedExternalEffects: externalEffectsBlocked,
    ...(signerGate ? { signerGate } : {}),
    decisions: applied.decisions,
    receipts,
  }
}

function emptyReport(
  dryRun: boolean,
  blockedExternalEffects = false,
): FcEngagementRunReport {
  return {
    proposed: 0,
    accepted: 0,
    rejected: 0,
    executed: 0,
    verified: 0,
    ambiguous: 0,
    dryRun,
    blockedExternalEffects,
    decisions: [],
    receipts: [],
  }
}

export function probeFcEngagementSummary(
  agentRoot: string,
  config: TrenchcoatConfig,
  signerProbe?: Readonly<{ status: string, mutationsAllowed?: boolean }>,
): unknown {
  const state = new StateStore(join(agentRoot, "state"))
  const file = state.loadFcEngagement()
  const nowIso = systemClock.nowIso()
  return {
    enabled: config.farcaster.enabled && config.farcaster.engagement.enabled,
    signerStatus: signerProbe?.status,
    signerMutations: signerProbe?.mutationsAllowed ? "allowed" : "blocked",
    likeThrottle: {
      max: config.farcaster.engagement.likes_per_window,
      windowMinutes: config.farcaster.engagement.like_window_minutes,
      usedInWindow: fcLikesInWindow(
        file,
        nowIso,
        config.farcaster.engagement.like_window_minutes,
      ),
    },
    liked: file.likedCastHashes.length,
    pending: file.pendingActionIds.length,
    daily: file.daily,
    decisions: file.decisions.length,
    receipts: file.receipts.length,
  }
}
