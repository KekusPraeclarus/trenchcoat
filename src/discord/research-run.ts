import { mkdirSync } from "node:fs"
import { systemClock } from "../lib/clock.js"
import { log } from "../lib/log.js"
import { SnapshotWriter } from "../lib/snapshot.js"
import { ensureArchive } from "../lib/archive.js"
import type { CanonicalIdentity } from "../contracts/schemas.js"
import {
  collectResearchDossier,
  resolveResearchSubject,
} from "../orchestrator/research-collect.js"
import { runResearchPasses } from "../orchestrator/research.js"
import {
  evaluateDiscordWatchSubscribe,
  evaluateResearchSubscribe,
} from "../orchestrator/research-verdict.js"
import { captureIntegritySnapshot, assertAgentIntegrity } from "../orchestrator/integrity.js"
import { buildHostChatFacts, promoteResearchChatReport } from "../orchestrator/chat-report.js"
import { preArchiveRun } from "../orchestrator/pre-archive.js"
import { ensureDiscordAgentWorkspace, readDiscordChatReport } from "./agent-setup.js"
import { observationFromDossier } from "./observation.js"
import { discordLayout } from "./paths.js"
import type { OperatorResearchInput } from "../orchestrator/research.js"
import type { DiscordObservation } from "./schemas.js"

export type DiscordResearchOutcome = Readonly<{
  status: "completed" | "rejected" | "ambiguous" | "failed"
  runId?: string
  reportText?: string
  identity?: CanonicalIdentity
  securityHardFail?: boolean
  /** Discord member-watch: true unless scanner hard-fail */
  subscribeAllowed?: boolean
  subscribeSkipReason?: string
  /** Main-agent track eligibility (validated track verdict) */
  mainTrackEligible?: boolean
  mainTrackSkipReason?: string
  error?: string
  shortlist?: CanonicalIdentity[]
  /** Watch baseline from the research dossier — no second collect */
  baseline?: DiscordObservation
  security?: Readonly<{
    status: string
    hardFail: boolean
    flags: readonly string[]
  }>
}>

function createResearchRunId(nowIso: string): string {
  const stamp = nowIso.replace(/[-:.TZ]/gu, "").slice(0, 14)
  return `discord-research-${stamp}`
}

function stageMs(started: number): number {
  return Date.now() - started
}

/** Caller must hold discord `.worker.lock` (pump / monitor exclusivity). */
export async function runDiscordResearch(args: Readonly<{
  repoRoot: string
  input: OperatorResearchInput
  model?: string
  nowIso?: string
  skipAgent?: boolean
}>): Promise<DiscordResearchOutcome> {
  const nowIso = args.nowIso ?? systemClock.nowIso()
  const layout = discordLayout()
  const agentRoot = ensureDiscordAgentWorkspace(args.repoRoot, layout)
  const archiveRoot = layout.archive
  mkdirSync(archiveRoot, { recursive: true, mode: 0o700 })
  const totalStarted = Date.now()

  try {
    const resolveStarted = Date.now()
    const resolved = await resolveResearchSubject(args.input)
    log.info("discord research stage", {
      stage: "resolve",
      ms: stageMs(resolveStarted),
      status: resolved.status,
    })
    if (resolved.status === "unsupported-chain") {
      return { status: "rejected", error: `unsupported chain ${resolved.chain}` }
    }
    if (resolved.status === "empty") {
      return { status: "rejected", error: "No supported market found for that contract." }
    }
    if (resolved.status === "ambiguous") {
      return {
        status: "ambiguous",
        shortlist: resolved.shortlist,
        error: "Multiple networks found. Resend as chain:address.",
      }
    }

    const identity = resolved.identity
    const runId = createResearchRunId(nowIso)
    const writer = new SnapshotWriter(agentRoot)
    const fetchedAt = systemClock.nowIso()
    let securityHardFail = false

    const dossierStarted = Date.now()
    const dossier = await collectResearchDossier({
      writer,
      runId,
      subject: args.input.subject,
      identity,
      fetchedAt,
      queueId: `discord:${args.input.requestId ?? runId}`,
      archiveRoot,
      pairs: resolved.pairs,
    })
    log.info("discord research stage", {
      stage: "dossier",
      runId,
      ms: stageMs(dossierStarted),
      snapshots: dossier.snapshotNames.length,
      security: dossier.security.status,
    })
    if (dossier.security.hardFail || dossier.security.status === "hard-fail") {
      securityHardFail = true
    }

    const security = {
      status: dossier.security.status,
      hardFail: dossier.security.hardFail,
      flags: dossier.security.flags,
    }

    const baseline = observationFromDossier({
      ...(dossier.market ? { market: dossier.market } : {}),
      security: dossier.security,
      ...(dossier.twitter ? { twitter: dossier.twitter } : {}),
    }, fetchedAt)

    if (!args.skipAgent) {
      const integrityBefore = captureIntegritySnapshot(agentRoot)
      const passesStarted = Date.now()
      await runResearchPasses({
        agentRoot,
        runId,
        subject: args.input.subject,
        identity,
        ...(args.model ? { model: args.model } : {}),
      })
      log.info("discord research stage", {
        stage: "passes",
        runId,
        ms: stageMs(passesStarted),
        status: "ok",
      })
      assertAgentIntegrity(agentRoot, integrityBefore)

      const promoteStarted = Date.now()
      const archive = await ensureArchive(archiveRoot)
      await preArchiveRun({
        layout: archive,
        agentRoot,
        runId,
        job: "research",
        nowIso: systemClock.nowIso(),
      })
      const chat = await promoteResearchChatReport({
        agentRoot,
        layout: archive,
        runId,
        nowIso: systemClock.nowIso(),
        subject: args.input.subject,
        facts: buildHostChatFacts({
          job: "research",
          runStatus: securityHardFail ? "rejected-security" : "complete",
          researchDue: { subject: args.input.subject, queueId: `discord:${runId}` },
          receiptPaths: [`reports/${runId}/agent.md`],
        }),
      })
      log.info("discord research stage", {
        stage: "promotion",
        runId,
        ms: stageMs(promoteStarted),
        status: chat.promoted ? "ok" : "failed",
      })
      if (!chat.promoted) {
        return { status: "failed", error: "report promotion failed" }
      }
    }

    const discordWatch = evaluateDiscordWatchSubscribe(security)
    const mainTrack = evaluateResearchSubscribe({
      agentRoot,
      runId,
      identity,
      security,
    })

    const reportText = readDiscordChatReport(agentRoot, runId)
      ?? `# Research\n\nSubject: ${args.input.subject}\n`
    log.info("discord research stage", {
      stage: "total",
      runId,
      ms: stageMs(totalStarted),
      status: "completed",
      discordSubscribe: discordWatch.subscribe,
      ...(discordWatch.reason ? { discordSubscribeReason: discordWatch.reason } : {}),
      mainTrack: mainTrack.subscribe,
      ...(mainTrack.reason ? { mainTrackReason: mainTrack.reason } : {}),
    })
    return {
      status: "completed",
      runId,
      reportText,
      identity,
      securityHardFail,
      subscribeAllowed: discordWatch.subscribe,
      ...(discordWatch.reason ? { subscribeSkipReason: discordWatch.reason } : {}),
      mainTrackEligible: mainTrack.subscribe,
      ...(mainTrack.reason ? { mainTrackSkipReason: mainTrack.reason } : {}),
      baseline,
      security,
    }
  } catch (error) {
    log.info("discord research stage", {
      stage: "total",
      ms: stageMs(totalStarted),
      status: "failed",
    })
    return {
      status: "failed",
      error: error instanceof Error ? error.message : "research failed",
    }
  }
}
