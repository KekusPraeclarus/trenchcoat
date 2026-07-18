import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import {
  extractNarrativeTickers,
  normalizeSymbol,
} from "../lib/narrative-tickers.js"
import type { StateStore } from "../lib/state.js"
import {
  narrativeLogPath,
  pruneNarrativeLogInMemory,
  type NarrativeLogEntry,
} from "./narrative-log.js"

const APPROX_TOKEN_BUDGET = 2_000
const CHARS_PER_TOKEN = 4

export type IndexReconcileReport = Readonly<{
  tokenLines: number
  narrativeLines: number
  truncated: boolean
  path: string
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

export async function reconcileIndex(args: Readonly<{
  agentRoot: string
  state: StateStore
  nowIso: string
}>): Promise<IndexReconcileReport> {
  const watchlist = args.state.loadWatchlist()
  const decisions = args.state.readDecisions()
  const narratives = readNarratives(args.agentRoot, args.nowIso)
  const decisionRows = parseDecisionRows(decisions)

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
    .map((entry) => (
      `${entry.slug} — ${entry.stage}, ${entry.title}, ${entry.lastSeen.slice(0, 10)}`
        + ` → ${narrativePointer(args.agentRoot, entry.slug)}`
    ))

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

  const path = join(args.agentRoot, "state", "INDEX.md")
  await writeAtomicFile(path, body)
  return {
    tokenLines: keptTokens.length,
    narrativeLines: keptNarratives.length,
    truncated,
    path,
  }
}
