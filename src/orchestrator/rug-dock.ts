/**
 * rug-dock — deterministic rug-shill attribution + dock (INV-S12 / INV-S13 / INV-S16).
 *
 * Triggered only by a typed scanner hard-fail. Host code links a source to the
 * failed candidate iff the source's RAW archived items mention the candidate's
 * contract or pair address within the lookback window — never from queue entries,
 * decisions.md, or any workspace file. model-confirmed identities never
 * participate in attribution (INV-S16). Each attributed item runs the isolated
 * intent classifier: `shill` hard docks immediately, `warn` defers to an
 * operator exoneration proposal. Either verdict increments rug-adjacency.
 *
 * Pure over its inputs (snapshots + flags supplied by the caller); it never reads
 * the workspace itself and routes every sources.json write through SourceWriter.
 */

import { sha256Bytes } from "../lib/fs-atomic.js"
import type { StateStore } from "../lib/state.js"
import type { ArchiveLayout } from "../lib/archive.js"
import type { CanonicalIdentity, SnapshotEnvelope } from "../contracts/schemas.js"
import { markHardDock } from "../sources/lifecycle.js"
import { SourceWriter, type SourcePlatform } from "./sources-write.js"
import { runIntentClassifier, type IntentSessionRunner } from "./intent-session.js"
import { proposeWarn, type OperatorNotifier } from "./exoneration.js"

export type RugDockIdentity = Readonly<{
  tokenAddress: string
  pairAddress?: string
  resolution: CanonicalIdentity["resolution"]
}>

type SourceRef = Readonly<{ sourceId: string; handle: string; platform: SourcePlatform }>

export type RugDockAttribution = Readonly<{
  sourceId: string
  provenance: string
  handle: string
  platform: SourcePlatform
  matchedAddress: string
  quotedMessageHash: `sha256:${string}`
  text: string
}>

export type RugDockReport = Readonly<{
  attributions: number
  docked: number
  warned: number
  capExhausted: number
  usedToday: number
  skippedModelConfirmed: boolean
}>

/** Map collector provenance to a deterministic source identity. */
export function provenanceToSource(provenance: string): SourceRef | undefined {
  const [platformRaw, ...rest] = provenance.split(":")
  const handle = rest.join(":").replace(/^@/u, "").trim().toLowerCase()
  if (!handle) return undefined
  switch (platformRaw) {
    case "twitter":
    case "x":
      return { sourceId: `x_${handle}`, handle, platform: "x" }
    case "telegram":
      return { sourceId: `tg_${handle}`, handle, platform: "telegram" }
    case "farcaster":
      return { sourceId: `fc_${handle}`, handle, platform: "farcaster" }
    default:
      return undefined
  }
}

function withinLookback(itemTs: string, nowIso: string, lookbackDays: number): boolean {
  const ts = Date.parse(itemTs)
  const now = Date.parse(nowIso)
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return false
  if (ts > now) return false
  return now - ts <= lookbackDays * 86_400_000
}

/** Host-side raw CA/pair attribution over pre-session snapshots. Deduped per message. */
export function attributeRugDock(args: Readonly<{
  identity: RugDockIdentity
  snapshots: readonly SnapshotEnvelope[]
  nowIso: string
  lookbackDays: number
}>): readonly RugDockAttribution[] {
  if (args.identity.resolution === "model-confirmed") return []

  const addresses = [args.identity.tokenAddress, args.identity.pairAddress]
    .filter((a): a is string => typeof a === "string" && a.length > 0)
    .map((a) => ({ raw: a, lower: a.toLowerCase() }))
  if (addresses.length === 0) return []

  const seen = new Set<string>()
  const out: RugDockAttribution[] = []
  for (const envelope of args.snapshots) {
    for (const item of envelope.items) {
      if (!withinLookback(item.ts, args.nowIso, args.lookbackDays)) continue
      const source = provenanceToSource(item.provenance)
      if (!source) continue
      const haystack = item.text.toLowerCase()
      const match = addresses.find((a) => haystack.includes(a.lower))
      if (!match) continue
      const quotedMessageHash = sha256Bytes(item.text)
      const key = `${source.sourceId}|${match.raw}|${quotedMessageHash}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        sourceId: source.sourceId,
        provenance: item.provenance,
        handle: source.handle,
        platform: source.platform,
        matchedAddress: match.raw,
        quotedMessageHash,
        text: item.text,
      })
    }
  }
  return out
}

export type RugDockArgs = Readonly<{
  store: StateStore
  layout: ArchiveLayout
  identity: RugDockIdentity
  scannerFlags: readonly string[]
  snapshots: readonly SnapshotEnvelope[]
  nowIso: string
  lookbackDays: number
  dailyCap: number
  usedToday: number
  runSession?: IntentSessionRunner
  notify?: OperatorNotifier
}>

export async function runRugDock(args: RugDockArgs): Promise<RugDockReport> {
  const empty: RugDockReport = {
    attributions: 0,
    docked: 0,
    warned: 0,
    capExhausted: 0,
    usedToday: args.usedToday,
    skippedModelConfirmed: args.identity.resolution === "model-confirmed",
  }

  // Dock only fires on a typed hard-fail
  if (args.scannerFlags.length === 0) return empty

  const attributions = attributeRugDock({
    identity: args.identity,
    snapshots: args.snapshots,
    nowIso: args.nowIso,
    lookbackDays: args.lookbackDays,
  })
  if (attributions.length === 0) return { ...empty, skippedModelConfirmed: empty.skippedModelConfirmed }

  const writer = new SourceWriter(args.store)
  const dockReason = `rug-shill:${args.scannerFlags.join(",")}`.slice(0, 280)

  let used = args.usedToday
  let docked = 0
  let warned = 0
  let capExhausted = 0

  for (const attribution of attributions) {
    const verdict = await runIntentClassifier({
      text: attribution.text,
      dailyCap: args.dailyCap,
      usedToday: used,
      ...(args.runSession ? { runSession: args.runSession } : {}),
    })
    used = verdict.used
    if (verdict.capExhausted) capExhausted += 1

    await writer.upsertNeutralSource({
      sourceId: attribution.sourceId,
      handle: attribution.handle,
      platform: attribution.platform,
    })

    if (verdict.verdict === "shill") {
      const lifecycle = args.store.loadSourceLifecycle()
      if (lifecycle.candidates.some((c) => c.sourceId === attribution.sourceId)) {
        await args.store.saveSourceLifecycle(
          markHardDock(lifecycle, attribution.sourceId, args.nowIso),
        )
      }
      await writer.setDocked({
        sourceId: attribution.sourceId,
        dockReason,
        incrementRugAdjacency: true,
      })
      docked += 1
      continue
    }

    await proposeWarn({
      layout: args.layout,
      writer,
      sourceId: attribution.sourceId,
      provenance: attribution.provenance,
      quotedMessageHash: attribution.quotedMessageHash,
      scannerFlags: args.scannerFlags,
      matchedAddress: attribution.matchedAddress,
      nowIso: args.nowIso,
      ...(args.notify ? { notify: args.notify } : {}),
    })
    warned += 1
  }

  return {
    attributions: attributions.length,
    docked,
    warned,
    capExhausted,
    usedToday: used,
    skippedModelConfirmed: false,
  }
}
