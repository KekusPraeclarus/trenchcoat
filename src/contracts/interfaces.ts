/**
 * Narrow coordinator-facing interfaces for Wave 1 modules.
 * Implementations live beside their modules; Wave 2 wires them into run.ts.
 */

import type {
  AlphaDigestReceipt,
  BroadcastBudgetLedger,
  BroadcastItem,
  DeliveryReceipt,
  ExonerationProposal,
  GateReceipt,
  OutcomeObservation,
  PairedEpisodeRecord,
  PostRunVerifierReport,
  QuarantineConflict,
  ResolutionReceipt,
  RunIncident,
  RunManifest,
  ValidationReceipt,
} from "./schemas.js"
import type { RunJournal, RunPhase } from "../orchestrator/journal.js"
import type { ArchiveLayout } from "../lib/archive.js"

export type JournalStore = Readonly<{
  load(runId: string): Promise<RunJournal | undefined>
  save(journal: RunJournal): Promise<void>
  mirrorToAgent?(agentRoot: string, journal: RunJournal): Promise<void>
}>

export type PreSessionArchiveResult = Readonly<{
  manifest: RunManifest
  inboxDir: string
}>

export type PostRunVerifierInput = Readonly<{
  layout: ArchiveLayout
  agentRoot: string
  runId: string
  beforeWatchlistHash: `sha256:${string}`
  afterWatchlistHash: `sha256:${string}`
  receipts: readonly ValidationReceipt[]
  gateReceipts: readonly GateReceipt[]
  nowIso: string
}>

export type PostRunVerifier = (
  input: PostRunVerifierInput,
) => Promise<PostRunVerifierReport>

export type QuarantineApi = Readonly<{
  quarantine(
    layout: ArchiveLayout,
    conflict: QuarantineConflict,
    journal?: RunJournal,
  ): Promise<void>
  isQuarantined(layout: ArchiveLayout, runId: string): boolean
}>

export type ResumeApi = Readonly<{
  findIncompleteRuns(layout: ArchiveLayout): Promise<string[]>
  nextPhase(journal: RunJournal): RunPhase | undefined
}>

export type AlphaPurgeApi = Readonly<{
  validateAndPurge(args: {
    agentRoot: string
    layout: ArchiveLayout
    runId: string
    nowIso: string
  }): Promise<AlphaDigestReceipt>
}>

export type OutboxIngestResult = Readonly<{
  staged: number
  rejected: number
  rejects: readonly { reason: string; itemHash?: `sha256:${string}` }[]
  items: readonly BroadcastItem[]
}>

export type BroadcastLedgerApi = Readonly<{
  load(layout: ArchiveLayout, dayKey: string): Promise<BroadcastBudgetLedger>
  reserve(args: {
    layout: ArchiveLayout
    dayKey: string
    reservationKey: string
    severity: BroadcastItem["severity"]
    dailyBudget: number
    urgentCeiling: number
    nowIso: string
  }): Promise<{ ok: boolean; ledger: BroadcastBudgetLedger; reason?: string }>
}>

export type DeliveryApi = Readonly<{
  deliverStaged(args: {
    layout: ArchiveLayout
    runId: string
    routerUrl: string
    hmacKey: string
    nowIso: string
  }): Promise<readonly DeliveryReceipt[]>
}>

export type ObservationMaterializer = Readonly<{
  materialize(args: {
    subjectType: OutcomeObservation["subjectType"]
    subjectId: string
    eventTs: string
    horizonHours: number
    bars: readonly { ts: string; open: number; finalized: boolean }[]
    benchmarkReturn?: number
    feeBpsPerSide?: number
    nowIso: string
  }): OutcomeObservation
}>

export type SettlementApi = Readonly<{
  settleSourceCalls(args: {
    layout: ArchiveLayout
    nowIso: string
    horizons: readonly number[]
    settlementHours: number
  }): Promise<{ written: number; pending: number }>
  settleWalletBuys(args: {
    layout: ArchiveLayout
    nowIso: string
    horizons: readonly number[]
    settlementHours: number
  }): Promise<{ written: number; pending: number }>
}>

export type ExonerationApi = Readonly<{
  proposeWarn(args: {
    layout: ArchiveLayout
    sourceId: string
    provenance: string
    quotedMessageHash: `sha256:${string}`
    scannerFlags: readonly string[]
    matchedAddress: string
    nowIso: string
  }): Promise<ExonerationProposal>
  confirm(id: string, by: "operator-telegram" | "operator-cli", nowIso: string): Promise<ExonerationProposal>
  undock(id: string, by: "operator-telegram" | "operator-cli", nowIso: string): Promise<ExonerationProposal>
}>

export type GateEvidenceApi = Readonly<{
  resolveGate(args: {
    layout: ArchiveLayout
    runId: string
    decisionId: string
    chain: GateReceipt["chain"]
    tokenAddress: string
    pairAddress?: string
    archived?: { status: GateReceipt["status"]; flags: string[]; rawHash?: `sha256:${string}` }
    liveRefetch?: () => Promise<{ status: GateReceipt["status"]; flags: string[]; rawHash?: `sha256:${string}` }>
    nowIso: string
  }): Promise<GateReceipt>
}>

export type PairedCanaryApi = Readonly<{
  recordEpisode(record: PairedEpisodeRecord): Promise<void>
  loadMatureCount(hypothesisId: string): Promise<number>
}>

export type IncidentWriter = (
  layout: ArchiveLayout,
  runId: string,
  incident: RunIncident,
) => Promise<void>

export type ResolutionEvidenceApi = Readonly<{
  writeResolution(receipt: ResolutionReceipt, layout: ArchiveLayout, runId: string): Promise<void>
}>
