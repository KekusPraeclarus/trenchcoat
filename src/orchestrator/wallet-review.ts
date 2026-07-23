import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ensureArchive, writeJsonRecord } from "../lib/archive.js"
import { loadConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { Outbox } from "../lib/outbox.js"
import { systemClock } from "../lib/clock.js"
import { sha256Json } from "../lib/canonical-json.js"
import { withAgentWorkspaceLock } from "../lib/lock.js"
import {
  WalletBuyOutcomeSchema,
  type WalletBuyOutcome,
} from "../contracts/schemas.js"
import { aggregateWalletPerformance } from "../wallets/outcomes.js"
import { reviewWalletLifecycle } from "../wallets/review.js"
import { transitionToRouterEvent } from "../wallets/lifecycle.js"
import { classifyHardExclusion, exclusionSubjectsFromEvidence, type ExclusionSubject } from "../wallets/exclusions.js"
import type { HardExclusion } from "../wallets/scoring.js"
import {
  blendWalletScores,
  deterministicWalletScore,
  parseWalletVote,
} from "../wallets/scoring.js"
import { performanceToEvidence } from "../wallets/outcomes.js"
import { WALLET_VOTER_PROMPT } from "../prompts/host.js"

export type WalletReviewReport = Readonly<{
  runId: string
  reviewed: number
  applied: number
  queued: number
  staged: number
  blockedExternal: boolean
}>

export type WalletVoteArchive = Readonly<{
  walletId: string
  evidenceCardHash: `sha256:${string}`
  voterPromptHash: `sha256:${string}`
  rawOutput: unknown
  parsedScore: number
  reasonCode: string
  deterministic: number
  llmWeight: number
  detWeight: number
  contribution: number
  blended: number
}>

export function loadWalletBuyOutcomes(archiveRoot: string): WalletBuyOutcome[] {
  const dir = join(archiveRoot, "outcomes")
  if (!existsSync(dir)) return []
  const out: WalletBuyOutcome[] = []
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("wallet-buy-") || !name.endsWith(".json")) continue
    const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
      outcomes?: unknown[]
    }
    for (const entry of raw.outcomes ?? []) {
      const parsed = WalletBuyOutcomeSchema.safeParse(entry)
      if (parsed.success) out.push(parsed.data)
    }
  }
  return out
}

export async function scoreWalletVote(args: Readonly<{
  evidenceCard: unknown
  runSession?: (prompt: string, card: unknown) => Promise<unknown>
}>): Promise<Readonly<{
  score: number
  rawOutput: unknown
  reasonCode: string
}>> {
  if (!args.runSession) {
    return { score: 50, rawOutput: null, reasonCode: "no-session" }
  }
  try {
    const raw = await args.runSession(WALLET_VOTER_PROMPT, args.evidenceCard)
    const parsed = parseWalletVote(raw)
    return {
      score: parsed.score_0_100,
      rawOutput: raw,
      reasonCode: parsed.reason_code,
    }
  } catch {
    return { score: 50, rawOutput: null, reasonCode: "session-error" }
  }
}

/**
 * Host wallet review: archive outcome reads are unlocked; wallets.json RMW and
 * lifecycle outbox staging hold a brief agent lock (ADR 027).
 */
export async function runWalletReview(args: Readonly<{
  agentRoot: string
  archiveRoot: string
  runId: string
  dryRun?: boolean
  blockExternalEffects?: boolean
  runSession?: (prompt: string, card: unknown) => Promise<unknown>
  hardExclusionSubjects?: ReadonlyMap<string, ExclusionSubject>
  /** When false, skip withAgentWorkspaceLock (caller already holds agent lock) */
  acquireLock?: boolean
}>): Promise<WalletReviewReport> {
  const config = loadConfig()
  const store = new StateStore(join(args.agentRoot, "state"))
  const archive = await ensureArchive(args.archiveRoot)
  const nowIso = systemClock.nowIso()
  const scoreCutoff = nowIso
  const outcomes = loadWalletBuyOutcomes(args.archiveRoot)
  const detWeight = config.wallets.deterministic_weight
  const llmWeight = config.wallets.llm_weight
  const voterPromptHash = sha256Json({ prompt: WALLET_VOTER_PROMPT })
  const acquireLock = args.acquireLock !== false

  const run = async (): Promise<WalletReviewReport> => {
    const file = store.loadWallets()
    const performances = new Map(
      file.wallets.map((wallet) => [
        wallet.walletId,
        aggregateWalletPerformance(wallet.walletId, outcomes, scoreCutoff, nowIso),
      ]),
    )

    const llmScores = new Map<string, number>()
    const voteArchives: WalletVoteArchive[] = []
    for (const wallet of file.wallets) {
      const perf = performances.get(wallet.walletId)
      if (!perf) continue
      const evidenceCard = {
        walletId: wallet.walletId,
        chain: wallet.chain,
        address: wallet.address,
        status: wallet.status,
        performance: perf,
      }
      const vote = await scoreWalletVote({
        evidenceCard,
        ...(args.runSession ? { runSession: args.runSession } : {}),
      })
      llmScores.set(wallet.walletId, vote.score)
      const deterministic = deterministicWalletScore(performanceToEvidence(perf))
      const blended = blendWalletScores(deterministic, vote.score, detWeight, llmWeight)
      voteArchives.push({
        walletId: wallet.walletId,
        evidenceCardHash: sha256Json(evidenceCard as never),
        voterPromptHash,
        rawOutput: vote.rawOutput,
        parsedScore: vote.score,
        reasonCode: vote.reasonCode,
        deterministic,
        llmWeight,
        detWeight,
        contribution: llmWeight * (vote.score / 100),
        blended,
      })
    }

    const hardExclusions = new Map<string, HardExclusion>()
    const subjects = new Map<string, ExclusionSubject>(
      exclusionSubjectsFromEvidence(file.exclusions ?? []),
    )
    if (args.hardExclusionSubjects) {
      for (const [id, subject] of args.hardExclusionSubjects) subjects.set(id, subject)
    }
    for (const wallet of file.wallets) {
      const subject = subjects.get(wallet.walletId)
      if (!subject) continue
      const reason = classifyHardExclusion(subject)
      if (reason) hardExclusions.set(wallet.walletId, reason)
    }

    const result = reviewWalletLifecycle({
      file,
      performances,
      llmScores,
      hardExclusions,
      epochId: args.runId,
      nowIso,
      thresholds: {
        max_transitions_per_review: config.wallets.max_transitions_per_review,
        deterministic_weight: detWeight,
        llm_weight: llmWeight,
        promotion: config.wallets.promotion,
        drop: config.wallets.drop,
      },
    })

    let staged = 0
    if (!args.dryRun) {
      await store.saveWallets(result.file)
      await writeJsonRecord(
        join(archive.wallets, `${args.runId}-review.json`),
        {
          schema: 1,
          runId: args.runId,
          scoreCutoff,
          applied: result.applied,
          queued: result.queued.map((t) => t.transitionId),
          voterPromptHash,
          votes: voteArchives,
        } as never,
      )

      if (!args.blockExternalEffects) {
        const outbox = new Outbox(join(archive.routerOutbox, args.runId))
        for (const transition of result.applied) {
          await outbox.stage(transitionToRouterEvent(transition))
          staged += 1
        }
      }
    }

    return {
      runId: args.runId,
      reviewed: file.wallets.length,
      applied: result.applied.length,
      queued: result.queued.length,
      staged,
      blockedExternal: Boolean(args.blockExternalEffects),
    }
  }

  if (acquireLock) {
    return withAgentWorkspaceLock(args.agentRoot, run)
  }
  return run()
}
