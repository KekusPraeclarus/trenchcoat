import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import { IsoTimestampSchema, SafeIdSchema, type CanonicalIdentity } from "../contracts/schemas.js"
import type { ResearchIntent } from "./research-intent.js"

const ChainHintSchema = z.enum(["solana", "ethereum", "base", "bsc", "robinhood"])

export const ResearchChoiceOptionSchema = z.object({
  index: z.number().int().min(1).max(5),
  chain: ChainHintSchema,
  tokenAddress: z.string().min(32).max(128),
  pairAddress: z.string().min(32).max(128).optional(),
  symbolDisplay: z.string().min(1).max(32).optional(),
})
export type ResearchChoiceOption = z.infer<typeof ResearchChoiceOptionSchema>

export const PendingResearchProposalSchema = z.object({
  requestId: SafeIdSchema,
  subject: z.string().min(1).max(256),
  chainHint: ChainHintSchema.optional(),
  tokenHint: z.string().min(32).max(128).optional(),
  proposedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  telegramUserId: z.string().min(1).max(64),
})
export type PendingResearchProposal = z.infer<typeof PendingResearchProposalSchema>

export const PendingResearchChoiceSchema = z.object({
  requestId: SafeIdSchema,
  subject: z.string().min(1).max(256),
  options: z.array(ResearchChoiceOptionSchema).min(2).max(5),
  proposedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  telegramUserId: z.string().min(1).max(64),
})
export type PendingResearchChoice = z.infer<typeof PendingResearchChoiceSchema>

export const ConfirmedResearchRequestSchema = z.object({
  requestId: SafeIdSchema,
  subject: z.string().min(1).max(256),
  chainHint: ChainHintSchema.optional(),
  tokenHint: z.string().min(32).max(128).optional(),
  status: z.enum([
    "queued",
    "running",
    "awaiting-choice",
    "done",
    "failed",
    "rejected",
    "notified",
  ]),
  confirmedAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  queueId: SafeIdSchema.optional(),
  runId: SafeIdSchema.optional(),
  reportPath: z.string().max(512).optional(),
  error: z.string().max(500).optional(),
  completionNotified: z.boolean().default(false),
})
export type ConfirmedResearchRequest = z.infer<typeof ConfirmedResearchRequestSchema>

export const PendingResearchFileSchema = z.object({
  schema: z.literal(1),
  telegramUserId: z.string().min(1).max(64),
  pending: PendingResearchProposalSchema.nullable().default(null),
  pendingChoice: PendingResearchChoiceSchema.nullable().default(null),
  confirmed: z.array(ConfirmedResearchRequestSchema).max(100).default([]),
})
export type PendingResearchFile = z.infer<typeof PendingResearchFileSchema>

export type PendingResearchStore = Readonly<{
  load(): PendingResearchFile
  save(file: PendingResearchFile): void
}>

export function emptyPendingResearchFile(telegramUserId = ""): PendingResearchFile {
  return { schema: 1, telegramUserId, pending: null, pendingChoice: null, confirmed: [] }
}

export function filePendingResearchStore(path: string): PendingResearchStore {
  return {
    load() {
      if (!existsSync(path)) return emptyPendingResearchFile()
      try {
        return PendingResearchFileSchema.parse(JSON.parse(readFileSync(path, "utf8")))
      } catch {
        return emptyPendingResearchFile()
      }
    },
    save(file) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const bound = file.telegramUserId.trim()
        ? file
        : emptyPendingResearchFile("unbound")
      const parsed = PendingResearchFileSchema.parse({
        ...bound,
        telegramUserId: bound.telegramUserId.trim() || "unbound",
        pendingChoice: bound.pendingChoice ?? null,
      })
      writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
    },
  }
}

export function createRequestId(nowIso: string): string {
  const stamp = nowIso.replace(/[-:.TZ]/gu, "").slice(0, 14)
  const suffix = Math.random().toString(36).slice(2, 8)
  return `rr-${stamp}-${suffix}`
}

function shortenAddress(address: string): string {
  if (address.length <= 14) return address
  return `${address.slice(0, 8)}…${address.slice(-4)}`
}

export function formatResearchChoicePrompt(args: Readonly<{
  subject: string
  options: readonly ResearchChoiceOption[]
  /** When false, still show chain — operator did not constrain the search */
  showChain?: boolean
}>): string {
  const showChain = args.showChain !== false
  const lines = [
    `Multiple matches for ${args.subject} — reply with a number or cancel:`,
    ...args.options.map((opt) => {
      const label = showChain
        ? `${opt.chain}:${shortenAddress(opt.tokenAddress)}`
        : shortenAddress(opt.tokenAddress)
      const sym = opt.symbolDisplay ? ` ${opt.symbolDisplay}` : ""
      return `${opt.index}. ${label}${sym}`
    }),
  ]
  return lines.join("\n")
}

export function optionsFromShortlist(
  shortlist: readonly CanonicalIdentity[],
): ResearchChoiceOption[] {
  return shortlist.slice(0, 5).map((item, i) => ({
    index: i + 1,
    chain: item.chain,
    tokenAddress: item.tokenAddress,
    ...(item.pairAddress ? { pairAddress: item.pairAddress } : {}),
    ...(item.symbolDisplay ? { symbolDisplay: item.symbolDisplay } : {}),
  }))
}

export function proposeResearch(args: Readonly<{
  file: PendingResearchFile
  telegramUserId: string
  intent: ResearchIntent
  nowIso: string
  ttlMinutes: number
}>): { file: PendingResearchFile; proposal: PendingResearchProposal } {
  if (!args.intent.subject) {
    throw new Error("research proposal requires a subject")
  }
  const expiresAt = new Date(
    Date.parse(args.nowIso) + args.ttlMinutes * 60_000,
  ).toISOString()
  const proposal: PendingResearchProposal = {
    requestId: createRequestId(args.nowIso),
    subject: args.intent.subject,
    proposedAt: args.nowIso,
    expiresAt,
    telegramUserId: args.telegramUserId,
    ...(args.intent.chainHint ? { chainHint: args.intent.chainHint } : {}),
    ...(args.intent.tokenHint ? { tokenHint: args.intent.tokenHint } : {}),
  }
  return {
    proposal,
    file: {
      schema: 1,
      telegramUserId: args.telegramUserId,
      pending: proposal,
      pendingChoice: null,
      confirmed: args.file.confirmed,
    },
  }
}

export function proposeResearchChoice(args: Readonly<{
  file: PendingResearchFile
  telegramUserId: string
  requestId: string
  subject: string
  shortlist: readonly CanonicalIdentity[]
  nowIso: string
  ttlMinutes: number
  showChain?: boolean
}>): { file: PendingResearchFile; choice: PendingResearchChoice; prompt: string } {
  const options = optionsFromShortlist(args.shortlist)
  if (options.length < 2) {
    throw new Error("research choice requires at least two options")
  }
  const expiresAt = new Date(
    Date.parse(args.nowIso) + args.ttlMinutes * 60_000,
  ).toISOString()
  const choice: PendingResearchChoice = {
    requestId: args.requestId,
    subject: args.subject,
    options,
    proposedAt: args.nowIso,
    expiresAt,
    telegramUserId: args.telegramUserId,
  }
  return {
    choice,
    prompt: formatResearchChoicePrompt({
      subject: args.subject,
      options,
      ...(args.showChain !== undefined ? { showChain: args.showChain } : {}),
    }),
    file: {
      ...args.file,
      telegramUserId: args.telegramUserId,
      pending: null,
      pendingChoice: choice,
    },
  }
}

export function clearExpiredPending(
  file: PendingResearchFile,
  nowIso: string,
): PendingResearchFile {
  let next = file
  if (next.pending && Date.parse(next.pending.expiresAt) < Date.parse(nowIso)) {
    next = { ...next, pending: null }
  }
  if (next.pendingChoice && Date.parse(next.pendingChoice.expiresAt) < Date.parse(nowIso)) {
    next = { ...next, pendingChoice: null }
  }
  return next
}

export function cancelPending(
  file: PendingResearchFile,
  telegramUserId: string,
): PendingResearchFile {
  if (file.pending && file.pending.telegramUserId !== telegramUserId) return file
  if (file.pendingChoice && file.pendingChoice.telegramUserId !== telegramUserId) return file
  return { ...file, telegramUserId, pending: null, pendingChoice: null }
}

export function confirmPending(args: Readonly<{
  file: PendingResearchFile
  telegramUserId: string
  nowIso: string
}>): { file: PendingResearchFile; confirmed?: ConfirmedResearchRequest; error?: string } {
  const file = clearExpiredPending(args.file, args.nowIso)
  if (file.pendingChoice) {
    return { file, error: "pick a number from the shortlist (or cancel)" }
  }
  if (!file.pending) {
    return { file, error: "no pending research to confirm" }
  }
  if (file.pending.telegramUserId !== args.telegramUserId) {
    return { file, error: "pending research belongs to another operator" }
  }
  if (Date.parse(file.pending.expiresAt) < Date.parse(args.nowIso)) {
    return { file: { ...file, pending: null }, error: "pending research expired" }
  }

  const confirmed: ConfirmedResearchRequest = {
    requestId: file.pending.requestId,
    subject: file.pending.subject,
    status: "queued",
    confirmedAt: args.nowIso,
    updatedAt: args.nowIso,
    completionNotified: false,
    ...(file.pending.chainHint ? { chainHint: file.pending.chainHint } : {}),
    ...(file.pending.tokenHint ? { tokenHint: file.pending.tokenHint } : {}),
  }

  return {
    confirmed,
    file: {
      schema: 1,
      telegramUserId: args.telegramUserId,
      pending: null,
      pendingChoice: null,
      confirmed: [...file.confirmed, confirmed].slice(-100),
    },
  }
}

export function selectResearchChoice(args: Readonly<{
  file: PendingResearchFile
  telegramUserId: string
  nowIso: string
  /** 1-based index, or `chain:address` matching an option */
  selection: string
}>): { file: PendingResearchFile; confirmed?: ConfirmedResearchRequest; error?: string } {
  const file = clearExpiredPending(args.file, args.nowIso)
  const choice = file.pendingChoice
  if (!choice) {
    return { file, error: "no pending shortlist to pick from" }
  }
  if (choice.telegramUserId !== args.telegramUserId) {
    return { file, error: "pending shortlist belongs to another operator" }
  }
  if (Date.parse(choice.expiresAt) < Date.parse(args.nowIso)) {
    return { file: { ...file, pendingChoice: null }, error: "shortlist expired — ask to research again" }
  }

  const trimmed = args.selection.trim()
  const byIndex = /^([1-5])\s*$/u.exec(trimmed)
  const byCa = /^(solana|ethereum|base|bsc|robinhood):([A-Za-z0-9]{32,128})$/iu.exec(trimmed)
  let option: ResearchChoiceOption | undefined
  if (byIndex?.[1]) {
    option = choice.options.find((o) => o.index === Number(byIndex[1]))
  } else if (byCa?.[1] && byCa[2]) {
    const chain = byCa[1].toLowerCase()
    const token = byCa[2]
    option = choice.options.find(
      (o) => o.chain === chain && o.tokenAddress.toLowerCase() === token.toLowerCase(),
    )
  }
  if (!option) {
    return { file, error: "invalid pick — reply with a listed number or cancel" }
  }

  const subject = `${option.chain}:${option.tokenAddress}`
  const confirmed: ConfirmedResearchRequest = {
    requestId: choice.requestId,
    subject,
    chainHint: option.chain,
    tokenHint: option.tokenAddress,
    status: "queued",
    confirmedAt: args.nowIso,
    updatedAt: args.nowIso,
    completionNotified: false,
  }

  const withoutOld = file.confirmed.filter((entry) => entry.requestId !== choice.requestId)
  return {
    confirmed,
    file: {
      schema: 1,
      telegramUserId: args.telegramUserId,
      pending: null,
      pendingChoice: null,
      confirmed: [...withoutOld, confirmed].slice(-100),
    },
  }
}

export function isResearchChoiceText(text: string): boolean {
  const trimmed = text.trim()
  return /^[1-5]\s*$/u.test(trimmed)
    || /^(solana|ethereum|base|bsc|robinhood):[A-Za-z0-9]{32,128}$/iu.test(trimmed)
}

export function patchConfirmed(
  file: PendingResearchFile,
  requestId: string,
  patch: Partial<ConfirmedResearchRequest>,
  nowIso: string,
): PendingResearchFile {
  return {
    ...file,
    confirmed: file.confirmed.map((entry) => (
      entry.requestId === requestId
        ? { ...entry, ...patch, updatedAt: nowIso }
        : entry
    )),
  }
}

export function nextQueuedRequest(
  file: PendingResearchFile,
): ConfirmedResearchRequest | undefined {
  return file.confirmed.find((entry) => entry.status === "queued")
}
