import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sha256Json } from "../lib/canonical-json.js"
import { runArchiveDir, writeJsonRecordFsync, type ArchiveLayout } from "../lib/archive.js"
import {
  MarketQualityEvidenceSchema,
  MarketQualityReceiptSchema,
  MarketQualityReasonSchema,
  SnapshotEnvelopeSchema,
  type CanonicalIdentity,
  type DecisionProposal,
  type MarketQualityEvidence,
  type MarketQualityReason,
  type MarketQualityReceipt,
} from "../contracts/schemas.js"
import {
  preflightMarketQuality,
  type SecurityThresholds,
} from "../collectors/market/security.js"
import type { MarketPair } from "../collectors/market/providers.js"

export type MarketQualityResolveResult = Readonly<{
  receiptId: `sha256:${string}`
  status: "pass" | "fail"
  reasons: readonly MarketQualityReason[]
  receipt: MarketQualityReceipt
}>

function dossierMatchesIdentity(
  item: Readonly<{ provenance: string; text: string; dedupeKey?: string }>,
  identity: Readonly<{ chain: string; tokenAddress: string; pairAddress: string }>,
): boolean {
  const chainToken = `${identity.chain}:${identity.tokenAddress}`
  if (item.dedupeKey === chainToken) return true
  if (item.provenance.includes(chainToken)) return true
  const chainField = /(?:^|\s)chain=([a-z0-9-]+)(?:\s|$)/u.exec(item.text)?.[1]
  const tokenField = /(?:^|\s)token=([A-Za-z0-9]+)(?:\s|$)/u.exec(item.text)?.[1]
  const pairField = /(?:^|\s)pair=([A-Za-z0-9]+)(?:\s|$)/u.exec(item.text)?.[1]
  if (chainField && tokenField) {
    return chainField === identity.chain
      && tokenField.toLowerCase() === identity.tokenAddress.toLowerCase()
      && (!pairField || pairField.toLowerCase() === identity.pairAddress.toLowerCase())
  }
  return false
}

/** Build market-quality evidence from a live pair snapshot. */
export function buildMarketQualityEvidence(args: Readonly<{
  identity: CanonicalIdentity
  pair: MarketPair
  previousLiquidityUsd?: number
  evaluatedAt: string
  source: MarketQualityEvidence["source"]
  thresholds?: SecurityThresholds
}>): MarketQualityEvidence {
  const result = preflightMarketQuality(
    args.pair,
    args.previousLiquidityUsd,
    args.thresholds,
  )
  return MarketQualityEvidenceSchema.parse({
    schema: 1,
    chain: args.identity.chain,
    tokenAddress: args.identity.tokenAddress,
    pairAddress: args.identity.pairAddress,
    status: result.status,
    reasons: [...result.reasons],
    evaluatedAt: args.evaluatedAt,
    source: args.source,
    ...(args.pair.liquidityUsd !== undefined
      ? { liquidityUsd: args.pair.liquidityUsd }
      : {}),
    ...(args.previousLiquidityUsd !== undefined
      ? { previousLiquidityUsd: args.previousLiquidityUsd }
      : {}),
  })
}

/** Format a market-quality inbox snapshot line. */
export function formatMarketQualitySnapshotText(
  evidence: MarketQualityEvidence,
): string {
  const reasons = evidence.reasons.length > 0
    ? evidence.reasons.join(",")
    : "none"
  const liquidityUsd = evidence.liquidityUsd !== undefined
    ? String(evidence.liquidityUsd)
    : "n/a"
  const previousLiquidityUsd = evidence.previousLiquidityUsd !== undefined
    ? String(evidence.previousLiquidityUsd)
    : "n/a"
  return [
    `chain=${evidence.chain}`,
    `token=${evidence.tokenAddress}`,
    `pair=${evidence.pairAddress}`,
    `status=${evidence.status}`,
    `reasons=${reasons}`,
    `liquidityUsd=${liquidityUsd}`,
    `previousLiquidityUsd=${previousLiquidityUsd}`,
  ].join(" ")
}

type ParsedMarketQuality = Readonly<{
  status: "pass" | "fail"
  reasons: MarketQualityReason[]
  chain?: string
  token?: string
  pair?: string
  liquidityUsd?: number
  previousLiquidityUsd?: number
}>

/** Parse a market-quality snapshot text line. */
export function parseMarketQualityText(text: string): ParsedMarketQuality | undefined {
  const statusMatch = /(?:^|\s)status=(pass|fail)(?:\s|$)/u.exec(text)
  if (!statusMatch) return undefined
  const status = statusMatch[1] as "pass" | "fail"
  const reasonsMatch = /(?:^|\s)reasons=([^ ]*)/u.exec(text)
  const rawReasons = (reasonsMatch?.[1] ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0 && r !== "none")
  const reasons: MarketQualityReason[] = []
  for (const raw of rawReasons) {
    const parsed = MarketQualityReasonSchema.safeParse(raw)
    if (parsed.success) reasons.push(parsed.data)
  }
  const chain = /(?:^|\s)chain=([a-z0-9-]+)(?:\s|$)/u.exec(text)?.[1]
  const token = /(?:^|\s)token=([A-Za-z0-9]+)(?:\s|$)/u.exec(text)?.[1]
  const pair = /(?:^|\s)pair=([A-Za-z0-9]+)(?:\s|$)/u.exec(text)?.[1]
  const liquidityRaw = /(?:^|\s)liquidityUsd=([^ ]+)/u.exec(text)?.[1]
  const previousRaw = /(?:^|\s)previousLiquidityUsd=([^ ]+)/u.exec(text)?.[1]
  const liquidityUsd = liquidityRaw && liquidityRaw !== "n/a"
    ? Number(liquidityRaw)
    : undefined
  const previousLiquidityUsd = previousRaw && previousRaw !== "n/a"
    ? Number(previousRaw)
    : undefined
  return {
    status,
    reasons,
    ...(chain ? { chain } : {}),
    ...(token ? { token } : {}),
    ...(pair ? { pair } : {}),
    ...(liquidityUsd !== undefined && Number.isFinite(liquidityUsd)
      ? { liquidityUsd }
      : {}),
    ...(previousLiquidityUsd !== undefined && Number.isFinite(previousLiquidityUsd)
      ? { previousLiquidityUsd }
      : {}),
  }
}

function buildReceipt(args: Readonly<{
  runId: string
  proposal: DecisionProposal
  status: "pass" | "fail"
  reasons: readonly MarketQualityReason[]
  source: MarketQualityReceipt["source"]
  nowIso: string
}>): MarketQualityReceipt {
  const identity = args.proposal.card.identity!
  return MarketQualityReceiptSchema.parse({
    schema: 1,
    receiptId: sha256Json({
      runId: args.runId,
      decisionId: args.proposal.card.decisionId,
      chain: identity.chain,
      token: identity.tokenAddress,
      pair: identity.pairAddress,
      status: args.status,
      source: args.source,
    }),
    decisionId: args.proposal.card.decisionId,
    chain: identity.chain,
    tokenAddress: identity.tokenAddress,
    pairAddress: identity.pairAddress,
    status: args.status,
    reasons: [...args.reasons],
    source: args.source,
    evaluatedAt: args.nowIso,
  })
}

/** Prefer same-run archived market-quality dossier; undefined when absent. */
export function resolveMarketQualityFromArchive(
  layout: ArchiveLayout,
  runId: string,
  proposal: DecisionProposal,
  nowIso: string,
): MarketQualityResolveResult | undefined {
  const identity = proposal.card.identity
  if (!identity) return undefined
  const inboxDir = join(runArchiveDir(layout, runId), "inbox")
  if (!existsSync(inboxDir)) return undefined

  let hit: ParsedMarketQuality | undefined
  for (const file of readdirSync(inboxDir)) {
    if (!file.includes("market-quality") || !file.endsWith(".json")) continue
    try {
      const envelope = SnapshotEnvelopeSchema.parse(
        JSON.parse(readFileSync(join(inboxDir, file), "utf8")),
      )
      for (const item of envelope.items) {
        if (!dossierMatchesIdentity({
          provenance: item.provenance,
          text: item.text,
          ...(item.dedupeKey ? { dedupeKey: item.dedupeKey } : {}),
        }, identity)) continue
        hit = parseMarketQualityText(item.text)
        if (hit) break
      }
    } catch {
      continue
    }
    if (hit) break
  }
  if (!hit) return undefined

  const receipt = buildReceipt({
    runId,
    proposal,
    status: hit.status,
    reasons: hit.reasons,
    source: "archived-dossier",
    nowIso,
  })
  return {
    receiptId: receipt.receiptId as `sha256:${string}`,
    status: receipt.status,
    reasons: receipt.reasons,
    receipt,
  }
}

/** Persist a market-quality receipt under the run archive. */
export async function writeMarketQualityReceipt(
  layout: ArchiveLayout,
  runId: string,
  receipt: MarketQualityReceipt,
): Promise<void> {
  await writeJsonRecordFsync(
    join(
      runArchiveDir(layout, runId),
      "market-quality-receipts",
      `${receipt.receiptId.slice(7, 23)}.json`,
    ),
    receipt as never,
  )
}
