import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { log } from "../lib/log.js"
import { telegramSendOperatorMessageChunks } from "../lib/telegram-bot.js"
import type { MetaCandidate, MetaUtilitySummary } from "../contracts/schemas.js"
import { metaCandidateDir } from "./meta-trial.js"

const OPERATOR_NOTIFY_MAX = 2_400

const MetaOperatorNotifyReceiptSchema = z.object({
  schema: z.literal(1),
  kind: z.literal("promotion_eligible"),
  candidateId: z.string().min(1).max(128),
  notifiedAt: z.string().min(1).max(64),
  channel: z.literal("telegram"),
}).strict()

export type MetaOperatorNotifyReceipt = z.infer<typeof MetaOperatorNotifyReceiptSchema>

export type MetaNotifySend = (
  text: string,
) => Promise<void>

function clip(text: string, max: number): string {
  const cleaned = text.replace(/\u0000/gu, "").trim()
  if ([...cleaned].length <= max) return cleaned
  return `${[...cleaned].slice(0, Math.max(0, max - 1)).join("")}…`
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`
}

function fmtDelta(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "n/a"
  const sign = n > 0 ? "+" : ""
  return `${sign}${n.toFixed(4)}`
}

export function metaOperatorNotifyReceiptPath(
  archiveRoot: string,
  candidateId: string,
): string {
  return join(metaCandidateDir(archiveRoot, candidateId), "operator-notify.json")
}

export function loadMetaOperatorNotifyReceipt(
  archiveRoot: string,
  candidateId: string,
): MetaOperatorNotifyReceipt | undefined {
  const path = metaOperatorNotifyReceiptPath(archiveRoot, candidateId)
  if (!existsSync(path)) return undefined
  try {
    return MetaOperatorNotifyReceiptSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return undefined
  }
}

/**
 * Host-built Telegram briefing for an operator who may have forgotten the
 * meta lane. Avoid ~/.trenchcoat paths — telegram-format strips them.
 */
export function renderMetaPromotionEligibleNotify(opts: Readonly<{
  candidate: MetaCandidate
  utility: MetaUtilitySummary
}>): string {
  const { candidate, utility } = opts
  const id = candidate.candidateId
  const rationale = clip(candidate.rationale.replace(/\s+/gu, " "), 280)

  const lines = [
    "Harness meta lane — promotion eligible",
    "",
    `Candidate \`${id}\` finished the shadow paired-trial bar (≥8 valid pairs).`,
    "This is **not** live yet. Nothing was integrated, deployed, or canaried.",
    "",
    "Scorecard:",
    `• valid pairs: ${utility.validPairs}`,
    `• wins: candidate ${utility.candidateWins} · baseline ${utility.baselineWins} · ties ${utility.ties}`,
    `• win rate: candidate ${pct(utility.candidateWinRate)} vs baseline ${pct(utility.baselineWinRate)}`,
    `• protected regressions: candidate ${utility.candidateProtectedRegressions} · baseline ${utility.baselineProtectedRegressions}`,
    `• median primary Δ: candidate ${fmtDelta(utility.medianCandidatePrimaryDelta)} · baseline ${fmtDelta(utility.medianBaselinePrimaryDelta)}`,
    "",
    "What this lane is:",
    "Shadow improver-config experiments (ADR 039). Only `config/harness-improver.json` mining/propose knobs — not `policy.json`, not harness code/gates.",
    "",
    `Candidate rationale: ${rationale}`,
    "",
    "What to do next (on the VPS / production host):",
    `1. Review: \`trenchcoat harness meta status\``,
    `2. If you agree, promote (ff-integrates improver config only): \`trenchcoat harness meta promote ${id}\``,
    `3. If not: \`trenchcoat harness meta reject ${id}\``,
    "",
    "From the Mac: `./ops/remote.sh -- 'trenchcoat harness meta status'` (same for promote/reject).",
    "Promote revalidates utility + confinement, then ff-only integrates. Revert = git revert + redeploy.",
    "Docs: docs/architecture/harness-improvement.md · ADR 039",
  ]
  return clip(lines.join("\n"), OPERATOR_NOTIFY_MAX)
}

async function defaultTelegramSend(text: string): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"]
  const operatorId = process.env["TELEGRAM_OPERATOR_ID"]
  if (!token || !operatorId) {
    log.warn("meta promotion_eligible notify skipped — TELEGRAM_BOT_TOKEN / TELEGRAM_OPERATOR_ID unset")
    return
  }
  await telegramSendOperatorMessageChunks(fetch, token, operatorId, text)
}

export type NotifyMetaPromotionEligibleResult = Readonly<{
  sent: boolean
  skippedReason?: "already-notified" | "not-eligible" | "send-failed" | "env-missing"
  text?: string
}>

/**
 * One-shot operator ping when a meta candidate becomes promotion_eligible.
 * Idempotent via operator-notify.json receipt.
 */
export async function notifyMetaPromotionEligible(opts: Readonly<{
  archiveRoot: string
  candidate: MetaCandidate
  utility: MetaUtilitySummary
  nowIso: string
  send?: MetaNotifySend
}>): Promise<NotifyMetaPromotionEligibleResult> {
  if (!opts.utility.promotionEligible) {
    return { sent: false, skippedReason: "not-eligible" }
  }
  if (opts.candidate.status !== "promotion_eligible") {
    return { sent: false, skippedReason: "not-eligible" }
  }

  const existing = loadMetaOperatorNotifyReceipt(
    opts.archiveRoot,
    opts.candidate.candidateId,
  )
  if (existing) {
    return { sent: false, skippedReason: "already-notified" }
  }

  const text = renderMetaPromotionEligibleNotify({
    candidate: opts.candidate,
    utility: opts.utility,
  })

  const send = opts.send ?? defaultTelegramSend
  const token = process.env["TELEGRAM_BOT_TOKEN"]
  const operatorId = process.env["TELEGRAM_OPERATOR_ID"]
  if (!opts.send && (!token || !operatorId)) {
    return { sent: false, skippedReason: "env-missing", text }
  }

  try {
    await send(text)
  } catch (error) {
    log.warn("meta promotion_eligible telegram notify failed", {
      candidateId: opts.candidate.candidateId,
      detail: error instanceof Error ? error.message : String(error),
    })
    return { sent: false, skippedReason: "send-failed", text }
  }

  const receipt = MetaOperatorNotifyReceiptSchema.parse({
    schema: 1,
    kind: "promotion_eligible",
    candidateId: opts.candidate.candidateId,
    notifiedAt: opts.nowIso,
    channel: "telegram",
  })
  await writeAtomicFile(
    metaOperatorNotifyReceiptPath(opts.archiveRoot, opts.candidate.candidateId),
    `${JSON.stringify(receipt, null, 2)}\n`,
  )
  log.info("meta promotion_eligible telegram notify sent", {
    candidateId: opts.candidate.candidateId,
  })
  return { sent: true, text }
}
