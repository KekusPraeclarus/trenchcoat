import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  ensureArchive,
  runArchiveDir,
  writeJsonRecordFsync,
  type ArchiveLayout,
} from "../lib/archive.js"
import type { JsonValue } from "../lib/canonical-json.js"
import { writeAtomicFile, sha256Bytes } from "../lib/fs-atomic.js"
import {
  extractNarrativeTickers,
  normalizeSymbol,
} from "../lib/narrative-tickers.js"
import type { StateStore } from "../lib/state.js"
import { RunManifestSchema } from "../contracts/schemas.js"
import { loadJournalForScan } from "./journal-store.js"
import {
  effectiveFraming,
  isMatureFraming,
} from "../lib/narrative-framing.js"
import {
  narrativeLogPath,
  pruneNarrativeLogInMemory,
  type NarrativeLogEntry,
} from "./narrative-log.js"

const APPROX_TOKEN_BUDGET = 2_000
const CHARS_PER_TOKEN = 4

export type IndexReconcileSources = Readonly<{
  watchlistUpdatedAt: string | null
  decisionsLatestDate: string | null
  narrativesLatestLastSeen: string | null
  narrativesCount: number
  watchlistCount: number
}>

/** Health/status must use sealed runs — never INDEX.md line dates */
export type SealedNarrativeFreshness = Readonly<{
  lastCompleteRunId: string | null
  lastCompleteAt: string | null
  ageSec: number | null
}>

export type IndexReconcileReport = Readonly<{
  tokenLines: number
  narrativeLines: number
  truncated: boolean
  path: string
  beforeHash: `sha256:${string}` | null
  afterHash: `sha256:${string}`
  changed: boolean
  sources: IndexReconcileSources
  reconciledAt: string
}>

export type IndexReconcileReceipt = Readonly<{
  schema: 1
  kind: "index-reconcile"
  runId: string
  job: string
  reconciledAt: string
  indexPath: string
  beforeHash: `sha256:${string}` | null
  afterHash: `sha256:${string}`
  changed: boolean
  tokenLines: number
  narrativeLines: number
  truncated: boolean
  sources: IndexReconcileSources
  sealedNarrativeFreshness: SealedNarrativeFreshness
  freshnessNote: "Narrative age for health/status comes from sealed complete narrative-scan runs, not INDEX.md line dates."
}>

type TokenLine = Readonly<{
  symbol: string
  status: string
  thesis: string
  date: string
  pointer: string
  rank: number
}>

function approxTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function latestThesis(decisions: string, decisionId: string | undefined): string | undefined {
  if (!decisionId) return undefined
  const block = decisions.split(/^## /mu).find((chunk) => chunk.startsWith(decisionId))
  if (!block) return undefined
  const thesis = block.match(/^- thesis:\s*(.+)$/mu)?.[1]?.trim()
  if (!thesis) return undefined
  return thesis.slice(0, 120)
}

function decisionDate(decisions: string, decisionId: string | undefined): string | undefined {
  if (!decisionId) return undefined
  const block = decisions.split(/^## /mu).find((chunk) => chunk.startsWith(decisionId))
  if (!block) return undefined
  return block.match(/^- date:\s*(\S+)/mu)?.[1]
}

function tokenPointer(agentRoot: string, symbol: string): string {
  const candidates = [
    join("state", "research", `${symbol}.md`),
    join("reports", "research", `${symbol}.md`),
  ]
  for (const rel of candidates) {
    if (existsSync(join(agentRoot, rel))) return rel
  }
  return "(no research artifact)"
}

function narrativePointer(agentRoot: string, slug: string): string {
  const rel = join("state", "narratives", `${slug}.md`)
  if (existsSync(join(agentRoot, rel))) return rel
  return "state/narratives/log.jsonl"
}

function readNarratives(agentRoot: string, nowIso: string): NarrativeLogEntry[] {
  const path = narrativeLogPath(agentRoot)
  if (!existsSync(path)) return []
  return pruneNarrativeLogInMemory(readFileSync(path, "utf8"), nowIso, 14).entries
}

function statusRank(status: string): number {
  switch (status) {
    case "tracking": return 0
    case "watching": return 1
    case "revisit": return 2
    case "ignored": return 3
    case "dropped": return 4
    case "removed": return 5
    case "narrative": return 6
    default: return 7
  }
}

export { extractNarrativeTickers }

type DecisionRow = Readonly<{
  decisionId: string
  verdict: string
  identityKey?: string
  subject?: string
  thesis?: string
  date?: string
}>

/** Parse decisions.md blocks for INDEX rollup (incl. operator-remove). */
export function parseDecisionRows(decisions: string): DecisionRow[] {
  const rows: DecisionRow[] = []
  for (const chunk of decisions.split(/^## /mu)) {
    const trimmed = chunk.trim()
    if (!trimmed) continue
    const header = trimmed.split("\n")[0] ?? ""
    const match = /^(?<id>\S+)\s+—\s+(?<verdict>[\w-]+)\s*(?<rest>.*)$/u.exec(header)
    if (!match?.groups) continue
    const decisionId = match.groups["id"] ?? ""
    const verdict = match.groups["verdict"] ?? ""
    const rest = (match.groups["rest"] ?? "").trim()
    const subject = trimmed.match(/^- subject:\s*(.+)$/mu)?.[1]?.trim()
    const thesis = trimmed.match(/^- thesis:\s*(.+)$/mu)?.[1]?.trim()
    const date = trimmed.match(/^- date:\s*(\S+)/mu)?.[1]
    const identityKey = rest && rest !== "unbound" && !rest.includes(" ")
      ? rest
      : undefined
    rows.push({
      decisionId,
      verdict,
      ...(identityKey ? { identityKey } : {}),
      ...(subject ? { subject } : {}),
      ...(thesis ? { thesis: thesis.slice(0, 120) } : {}),
      ...(date ? { date } : {}),
    })
  }
  return rows
}

function symbolFromDecision(row: DecisionRow): string | undefined {
  if (row.subject) return normalizeSymbol(row.subject)
  if (row.thesis) {
    const dollar = row.thesis.match(/\$([A-Za-z][A-Za-z0-9]{1,20})\b/u)?.[1]
    if (dollar) return normalizeSymbol(dollar)
  }
  return undefined
}

function verdictStatus(verdict: string): string {
  switch (verdict) {
    case "track": return "tracking"
    case "drop": return "dropped"
    case "ignore": return "ignored"
    case "revisit": return "revisit"
    case "operator-remove": return "removed"
    default: return verdict
  }
}

function formatTokenLine(line: TokenLine): string {
  return `$${line.symbol} — ${line.status}, ${line.thesis}, ${line.date} → ${line.pointer}`
}

export function indexMdPath(agentRoot: string): string {
  return join(agentRoot, "state", "INDEX.md")
}

export function hashIndexMd(agentRoot: string): `sha256:${string}` | null {
  const path = indexMdPath(agentRoot)
  if (!existsSync(path)) return null
  return sha256Bytes(readFileSync(path))
}

function collectSources(args: Readonly<{
  state: StateStore
  decisionRows: readonly DecisionRow[]
  narratives: readonly NarrativeLogEntry[]
}>): IndexReconcileSources {
  const watchlist = args.state.loadWatchlist()
  let watchlistUpdatedAt: string | null = null
  for (const entry of watchlist.entries) {
    if (!watchlistUpdatedAt || entry.updatedAt > watchlistUpdatedAt) {
      watchlistUpdatedAt = entry.updatedAt
    }
  }
  let decisionsLatestDate: string | null = null
  for (const row of args.decisionRows) {
    if (!row.date) continue
    if (!decisionsLatestDate || row.date > decisionsLatestDate) {
      decisionsLatestDate = row.date
    }
  }
  let narrativesLatestLastSeen: string | null = null
  for (const entry of args.narratives) {
    if (!narrativesLatestLastSeen || entry.lastSeen > narrativesLatestLastSeen) {
      narrativesLatestLastSeen = entry.lastSeen
    }
  }
  return {
    watchlistUpdatedAt,
    decisionsLatestDate,
    narrativesLatestLastSeen,
    narrativesCount: args.narratives.length,
    watchlistCount: watchlist.entries.length,
  }
}

/**
 * Newest sealed complete narrative-scan run. Health/status narrative age uses
 * this — never the human-readable dates inside INDEX.md.
 */
export async function resolveSealedNarrativeFreshness(args: Readonly<{
  archiveRoot: string
  nowIso: string
}>): Promise<SealedNarrativeFreshness> {
  const layout = await ensureArchive(args.archiveRoot)
  if (!existsSync(layout.transactions)) {
    return { lastCompleteRunId: null, lastCompleteAt: null, ageSec: null }
  }
  let best: { runId: string; createdAt: string } | undefined
  for (const name of readdirSync(layout.transactions)) {
    if (!name.endsWith(".json")) continue
    const runId = name.slice(0, -".json".length)
    const loaded = await loadJournalForScan(layout, runId)
    if (!loaded || loaded.status !== "complete") continue
    const manifestPath = join(runArchiveDir(layout, runId), "manifest.json")
    if (!existsSync(manifestPath)) continue
    let manifest
    try {
      manifest = RunManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")))
    } catch {
      continue
    }
    if (manifest.job !== "narrative-scan") continue
    if (!best || Date.parse(manifest.createdAt) > Date.parse(best.createdAt)) {
      best = { runId, createdAt: manifest.createdAt }
    }
  }
  if (!best) {
    return { lastCompleteRunId: null, lastCompleteAt: null, ageSec: null }
  }
  const ageSec = Math.max(
    0,
    Math.floor((Date.parse(args.nowIso) - Date.parse(best.createdAt)) / 1_000),
  )
  return {
    lastCompleteRunId: best.runId,
    lastCompleteAt: best.createdAt,
    ageSec: Number.isFinite(ageSec) ? ageSec : null,
  }
}

export function buildIndexReconcileReceipt(args: Readonly<{
  runId: string
  job: string
  report: IndexReconcileReport
  sealedNarrativeFreshness: SealedNarrativeFreshness
}>): IndexReconcileReceipt {
  return {
    schema: 1,
    kind: "index-reconcile",
    runId: args.runId,
    job: args.job,
    reconciledAt: args.report.reconciledAt,
    indexPath: args.report.path,
    beforeHash: args.report.beforeHash,
    afterHash: args.report.afterHash,
    changed: args.report.changed,
    tokenLines: args.report.tokenLines,
    narrativeLines: args.report.narrativeLines,
    truncated: args.report.truncated,
    sources: args.report.sources,
    sealedNarrativeFreshness: args.sealedNarrativeFreshness,
    freshnessNote:
      "Narrative age for health/status comes from sealed complete narrative-scan runs, not INDEX.md line dates.",
  }
}

export async function writeIndexReconcileReceipt(args: Readonly<{
  layout: ArchiveLayout
  runId: string
  receipt: IndexReconcileReceipt
  reportDir?: string
}>): Promise<void> {
  const runDir = runArchiveDir(args.layout, args.runId)
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  await writeJsonRecordFsync(
    join(runDir, "index-reconcile-receipt.json"),
    JSON.parse(JSON.stringify(args.receipt)) as JsonValue,
  )
  if (args.reportDir) {
    mkdirSync(args.reportDir, { recursive: true, mode: 0o700 })
    writeFileSync(
      join(args.reportDir, "index-reconcile-receipt.json"),
      `${JSON.stringify(args.receipt, null, 2)}\n`,
    )
  }
}

export async function reconcileIndex(args: Readonly<{
  agentRoot: string
  state: StateStore
  nowIso: string
}>): Promise<IndexReconcileReport> {
  const beforeHash = hashIndexMd(args.agentRoot)
  const watchlist = args.state.loadWatchlist()
  const decisions = args.state.readDecisions()
  const narratives = readNarratives(args.agentRoot, args.nowIso)
  const decisionRows = parseDecisionRows(decisions)
  const sources = collectSources({ state: args.state, decisionRows, narratives })

  const bySymbol = new Map<string, TokenLine>()
  const onWatchlist = new Set<string>()

  for (const entry of watchlist.entries) {
    const symbol = entry.identity.symbolDisplay
    const key = symbol.toLowerCase()
    onWatchlist.add(key)
    const thesis = latestThesis(decisions, entry.lastDecisionId) ?? "(no thesis)"
    const date = decisionDate(decisions, entry.lastDecisionId)
      ?? entry.updatedAt.slice(0, 10)
    bySymbol.set(key, {
      symbol,
      status: entry.status,
      thesis,
      date,
      pointer: tokenPointer(args.agentRoot, symbol),
      rank: statusRank(entry.status),
    })
  }

  // Decided tokens not on the watchlist (e.g. REPPO after operator-remove).
  // Append-only decisions.md: later rows overwrite earlier ones.
  for (const row of decisionRows) {
    const symbol = symbolFromDecision(row)
    if (!symbol) continue
    const key = symbol.toLowerCase()
    if (onWatchlist.has(key)) continue
    const status = verdictStatus(row.verdict)
    bySymbol.set(key, {
      symbol,
      status,
      thesis: row.thesis
        ?? (status === "removed" ? "removed from watchlist" : "(no thesis)"),
      date: row.date?.slice(0, 10) ?? args.nowIso.slice(0, 10),
      pointer: tokenPointer(args.agentRoot, symbol),
      rank: statusRank(status),
    })
  }

  // Narrative-linked tickers still missing from the rollup
  for (const narrative of narratives) {
    for (const symbol of extractNarrativeTickers(narrative)) {
      const key = symbol.toLowerCase()
      if (bySymbol.has(key)) continue
      bySymbol.set(key, {
        symbol,
        status: "narrative",
        thesis: narrative.title.slice(0, 120),
        date: narrative.lastSeen.slice(0, 10),
        pointer: narrativePointer(args.agentRoot, narrative.slug),
        rank: statusRank("narrative"),
      })
    }
  }

  const tokenLines = [...bySymbol.values()]
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      return a.symbol.toLowerCase().localeCompare(b.symbol.toLowerCase())
    })
    .map(formatTokenLine)

  const narrativeLines = [...narratives]
    .sort((a, b) => {
      if (a.lastSeen !== b.lastSeen) return b.lastSeen.localeCompare(a.lastSeen)
      return a.slug.localeCompare(b.slug)
    })
    .map((entry) => {
      const framing = effectiveFraming(entry)
      const framingPart = isMatureFraming(framing) ? `, framing=${framing}` : ""
      return `${entry.slug} — ${entry.stage}, ${entry.title}${framingPart}, ${entry.lastSeen.slice(0, 10)}`
        + ` → ${narrativePointer(args.agentRoot, entry.slug)}`
    })

  const header = [
    "# INDEX",
    "",
    "Host-owned retrieval rollup. Authoritative sources remain watchlist,",
    "decisions.md, and narratives/log.jsonl. Do not edit this file from the model.",
    "",
  ]

  const keptTokens: string[] = []
  const keptNarratives: string[] = []
  let truncated = false
  let budget = APPROX_TOKEN_BUDGET - approxTokens(header.join("\n") + "\n## Tokens\n\n## Narratives\n")

  for (const line of tokenLines) {
    const cost = approxTokens(line) + 1
    if (cost > budget) {
      truncated = true
      break
    }
    keptTokens.push(line)
    budget -= cost
  }
  for (const line of narrativeLines) {
    const cost = approxTokens(line) + 1
    if (cost > budget) {
      truncated = true
      break
    }
    keptNarratives.push(line)
    budget -= cost
  }

  const body = [
    ...header,
    "## Tokens",
    "",
    ...(keptTokens.length > 0 ? keptTokens : ["(none yet)"]),
    "",
    "## Narratives",
    "",
    ...(keptNarratives.length > 0 ? keptNarratives : ["(none yet)"]),
    "",
  ].join("\n")

  const path = indexMdPath(args.agentRoot)
  await writeAtomicFile(path, body)
  const afterHash = sha256Bytes(body)
  return {
    tokenLines: keptTokens.length,
    narrativeLines: keptNarratives.length,
    truncated,
    path,
    beforeHash,
    afterHash,
    changed: beforeHash !== afterHash,
    sources,
    reconciledAt: args.nowIso,
  }
}

/** Reconcile INDEX and archive (+ optional report mirror) a proof receipt. */
export async function reconcileIndexWithReceipt(args: Readonly<{
  agentRoot: string
  state: StateStore
  nowIso: string
  layout: ArchiveLayout
  runId: string
  job: string
  archiveRoot: string
  reportDir?: string
}>): Promise<IndexReconcileReceipt> {
  const report = await reconcileIndex({
    agentRoot: args.agentRoot,
    state: args.state,
    nowIso: args.nowIso,
  })
  const sealedNarrativeFreshness = await resolveSealedNarrativeFreshness({
    archiveRoot: args.archiveRoot,
    nowIso: args.nowIso,
  })
  const receipt = buildIndexReconcileReceipt({
    runId: args.runId,
    job: args.job,
    report,
    sealedNarrativeFreshness,
  })
  await writeIndexReconcileReceipt({
    layout: args.layout,
    runId: args.runId,
    receipt,
    ...(args.reportDir ? { reportDir: args.reportDir } : {}),
  })
  return receipt
}
