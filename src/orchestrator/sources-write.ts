/**
 * sources-write — the SOLE writer of agent/state/sources.json (INV-S7 / INV-S12).
 *
 * No other module may call StateStore.saveSources. Every host-side sources.json
 * mutation funnels through here so the write surface stays small and auditable:
 *   - neutral auto-registration (upsertNeutralSource)
 *   - lagged audit scoring (applyLaggedScore)
 *   - rug-shill dock + operator confirm (setDocked)
 *   - operator undock (clearDock)
 *
 * Host-only by construction: a SourceWriter is built from a StateStore, an object
 * that model sessions never hold. The constructor additionally refuses to bind to
 * a sources path that lives under an agent-authored surface (inbox, alpha-queue,
 * outbox, reports) so a mislocated store can never be mutated as if it were host
 * state. No model-authored artifact ever reaches these functions (INV-S12).
 */

import { resolve, sep } from "node:path"
import type { StateStore } from "../lib/state.js"
import {
  SourceRecordSchema,
  type SourceRecord,
  type SourcesFile,
} from "../contracts/schemas.js"

export const NEUTRAL_SOURCE_SCORE = 0.5

export type SourcePlatform = SourceRecord["platform"]

export type NeutralSourceInput = Readonly<{
  sourceId: string
  handle: string
  platform: SourcePlatform
}>

export type LaggedScoreInput = Readonly<{
  sourceId: string
  score: number
  scoreUpdatedAt: string
}>

export type DockInput = Readonly<{
  sourceId: string
  dockReason: string
  // adjacency counts distinct rug events; only increment on the false->true dock
  // flip so retries stay idempotent (INV-S13 "increments regardless of verdict"
  // is satisfied at first dock)
  incrementRugAdjacency?: boolean
}>

// Agent-authored surfaces under agent/. A sources.json under any of these would
// mean the writer was pointed at model-writable state, never host state.
const AGENT_AUTHORED_SEGMENTS = ["inbox", "alpha-queue", "outbox", "reports"]

function clampScore(score: number): number {
  if (!Number.isFinite(score)) throw new TypeError("sources-write: non-finite score")
  return Math.min(1, Math.max(0, score))
}

export class SourceWriter {
  constructor(private readonly store: StateStore) {
    const path = resolve(store.sourcesPath())
    const segments = path.split(sep)
    if (!segments.includes("state")) {
      throw new Error(`sources-write: refusing non-state sources path ${path}`)
    }
    if (segments.some((seg) => AGENT_AUTHORED_SEGMENTS.includes(seg))) {
      throw new Error(`sources-write: refusing agent-authored sources path ${path}`)
    }
  }

  private async write(next: SourcesFile): Promise<SourcesFile> {
    await this.store.saveSources(next)
    return next
  }

  private replace(file: SourcesFile, record: SourceRecord): SourcesFile {
    const parsed = SourceRecordSchema.parse(record)
    const others = file.sources.filter((s) => s.sourceId !== parsed.sourceId)
    return {
      schema: 1,
      sources: [...others, parsed].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    }
  }

  private require(file: SourcesFile, sourceId: string): SourceRecord {
    const found = file.sources.find((s) => s.sourceId === sourceId)
    if (!found) throw new Error(`sources-write: unknown source ${sourceId}`)
    return found
  }

  /** Register a source at neutral score if unseen. Idempotent: never overwrites. */
  async upsertNeutralSource(input: NeutralSourceInput): Promise<SourcesFile> {
    const file = this.store.loadSources()
    if (file.sources.some((s) => s.sourceId === input.sourceId)) return file
    const record: SourceRecord = {
      schema: 1,
      sourceId: input.sourceId,
      handle: input.handle,
      platform: input.platform,
      score: NEUTRAL_SOURCE_SCORE,
      docked: false,
      rugAdjacency: 0,
    }
    return this.write(this.replace(file, record))
  }

  /** Apply a lagged audit score to a known source. Score only, never dock/adjacency. */
  async applyLaggedScore(input: LaggedScoreInput): Promise<SourcesFile> {
    const file = this.store.loadSources()
    const existing = this.require(file, input.sourceId)
    return this.write(this.replace(file, {
      ...existing,
      score: clampScore(input.score),
      scoreUpdatedAt: input.scoreUpdatedAt,
    }))
  }

  /**
   * Dock a source (rug-shill dock or operator confirm). Idempotent on the dock
   * flag: a second dock keeps the source docked but never re-increments adjacency,
   * so run retries do not inflate the repeat-offender counter.
   */
  async setDocked(input: DockInput): Promise<SourcesFile> {
    const file = this.store.loadSources()
    const existing = this.require(file, input.sourceId)
    const flippedToDocked = !existing.docked
    return this.write(this.replace(file, {
      ...existing,
      docked: true,
      dockReason: input.dockReason,
      rugAdjacency: existing.rugAdjacency
        + (flippedToDocked && input.incrementRugAdjacency ? 1 : 0),
    }))
  }

  /** Clear a dock (operator undock). Idempotent; never touches score or adjacency. */
  async clearDock(sourceId: string): Promise<SourcesFile> {
    const file = this.store.loadSources()
    const existing = this.require(file, sourceId)
    const next = { ...existing, docked: false }
    delete (next as { dockReason?: string }).dockReason
    return this.write(this.replace(file, next))
  }
}
