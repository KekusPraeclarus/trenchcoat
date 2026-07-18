import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sha256Json } from "../lib/canonical-json.js"
import { runArchiveDir, writeJsonRecordFsync, type ArchiveLayout } from "../lib/archive.js"
import {
  SnapshotEnvelopeSchema,
  type DecisionProposal,
  type GateReceipt,
} from "../contracts/schemas.js"
import { fetchSecurityGate } from "../collectors/market/security.js"
import { loadConfig, securityThresholdsFromConfig } from "../lib/config.js"
import type { FetchLike } from "../collectors/market/geckoterminal.js"

/** Provenance ids cited in the pre-session archived inbox snapshots */
export function archivedProvenanceAllowlist(
  layout: ArchiveLayout,
  runId: string,
): Set<string> {
  const inboxDir = join(runArchiveDir(layout, runId), "inbox")
  const allowed = new Set<string>()
  if (!existsSync(inboxDir)) return allowed
  for (const file of readdirSync(inboxDir)) {
    if (!file.endsWith(".json")) continue
    try {
      const envelope = SnapshotEnvelopeSchema.parse(
        JSON.parse(readFileSync(join(inboxDir, file), "utf8")),
      )
      for (const item of envelope.items) allowed.add(item.provenance)
    } catch {
      // Non-snapshot inbox files do not contribute
    }
  }
  return allowed
}

type ArchivedGateHit = Readonly<{
  status: GateReceipt["status"]
  flags: string[]
  rawHash?: `sha256:${string}`
}>

function parseSecurityText(text: string): ArchivedGateHit | undefined {
  const statusMatch = /(?:^|\s)status=([a-z-]+)(?:\s|$)/u.exec(text)
  if (!statusMatch) return undefined
  const raw = statusMatch[1]!
  const hardFail = /(?:^|\s)hardFail=true(?:\s|$)/u.test(text)
  const flagsMatch = /(?:^|\s)flags=([^ ]*)/u.exec(text)
  const flags = (flagsMatch?.[1] ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && f !== "none")
  let status: GateReceipt["status"]
  if (hardFail || raw === "hard-fail" || raw === "fail") status = "hard-fail"
  else if (raw === "pass" || raw === "ok") status = "pass"
  else if (raw === "pending") status = "pending"
  else if (raw === "unsupported-chain") status = "unsupported-chain"
  else return undefined
  return { status, flags }
}

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

function buildReceipt(args: Readonly<{
  runId: string
  proposal: DecisionProposal
  status: GateReceipt["status"]
  flags: readonly string[]
  source: GateReceipt["source"]
  nowIso: string
  provider?: GateReceipt["provider"]
  rawHash?: `sha256:${string}`
}>): GateReceipt {
  const identity = args.proposal.card.identity!
  return {
    schema: 1,
    receiptId: sha256Json({
      runId: args.runId,
      decisionId: args.proposal.card.decisionId,
      chain: identity.chain,
      token: identity.tokenAddress,
      status: args.status,
      source: args.source,
    }) as `sha256:${string}`,
    decisionId: args.proposal.card.decisionId,
    chain: identity.chain,
    tokenAddress: identity.tokenAddress,
    pairAddress: identity.pairAddress,
    status: args.status,
    flags: [...args.flags],
    ...(args.provider ? { provider: args.provider } : {}),
    ...(args.rawHash ? { rawHash: args.rawHash } : {}),
    source: args.source,
    evaluatedAt: args.nowIso,
  }
}

/** Prefer same-run archived security dossier; undefined when absent */
export function resolveGateFromArchive(
  layout: ArchiveLayout,
  runId: string,
  proposal: DecisionProposal,
  nowIso: string,
): { receiptId: `sha256:${string}`; status: GateReceipt["status"]; receipt: GateReceipt } | undefined {
  const identity = proposal.card.identity
  if (!identity) return undefined
  const inboxDir = join(runArchiveDir(layout, runId), "inbox")
  if (!existsSync(inboxDir)) return undefined

  let hit: ArchivedGateHit | undefined
  for (const file of readdirSync(inboxDir)) {
    if (!file.includes("security") || !file.endsWith(".json")) continue
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
        hit = parseSecurityText(item.text)
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
    flags: hit.flags,
    source: "archived-dossier",
    nowIso,
    ...(hit.rawHash ? { rawHash: hit.rawHash } : {}),
  })
  return {
    receiptId: receipt.receiptId as `sha256:${string}`,
    status: receipt.status,
    receipt,
  }
}

/**
 * Archive dossier first; if absent, allowlisted live refetch via GoPlus/Rugcheck.
 * Failures become pending receipts (never invent a pass).
 */
export async function resolveGateArchiveThenLive(args: Readonly<{
  layout: ArchiveLayout
  runId: string
  proposal: DecisionProposal
  nowIso: string
  fetcher?: FetchLike
  enableLiveRefetch?: boolean
}>): Promise<{ receiptId: `sha256:${string}`; status: GateReceipt["status"]; receipt: GateReceipt } | undefined> {
  const archived = resolveGateFromArchive(
    args.layout,
    args.runId,
    args.proposal,
    args.nowIso,
  )
  if (archived) return archived

  const identity = args.proposal.card.identity
  if (!identity || args.enableLiveRefetch === false) return undefined

  const live = await fetchSecurityGate(
    args.fetcher ?? fetch,
    identity.chain,
    identity.tokenAddress,
    securityThresholdsFromConfig(loadConfig()),
  )
  const rawHash = sha256Json({
    chain: identity.chain,
    token: identity.tokenAddress,
    status: live.status,
    flags: [...live.flags],
    reason: live.reason ?? null,
    provider: live.provider ?? null,
  })

  const receipt = buildReceipt({
    runId: args.runId,
    proposal: args.proposal,
    status: live.status,
    flags: live.flags,
    source: "live-refetch",
    nowIso: args.nowIso,
    ...(live.provider ? { provider: live.provider } : {}),
    rawHash,
  })

  await writeJsonRecordFsync(
    join(
      runArchiveDir(args.layout, args.runId),
      "gate-receipts",
      `live-${rawHash.slice(7, 23)}.json`,
    ),
    {
      schema: 1,
      kind: "live-refetch",
      decisionId: args.proposal.card.decisionId,
      result: {
        status: live.status,
        hardFail: live.hardFail,
        flags: [...live.flags],
        ...(live.provider ? { provider: live.provider } : {}),
        ...(live.reason ? { reason: live.reason } : {}),
      },
      receipt,
    } as never,
  )

  return {
    receiptId: receipt.receiptId as `sha256:${string}`,
    status: receipt.status,
    receipt,
  }
}
