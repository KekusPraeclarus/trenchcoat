import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveLayout } from "../../src/lib/archive.js"
import { sha256Json } from "../../src/lib/canonical-json.js"
import { writeOutcomeObservation } from "../../src/orchestrator/scorecard.js"
import { loadSourceCallOutcomes } from "../../src/orchestrator/sources.js"
import { sourceCallLogPath } from "../../src/orchestrator/call-log.js"
import type { SourceCallEvent } from "../../src/contracts/schemas.js"

const TOKEN_X = "So11111111111111111111111111111111111111112"
const TOKEN_FOMO = "So11111111111111111111111111111111111111113"
const MENTION = "2026-08-01T00:00:00.000Z"
const OBSERVED = "2026-08-08T00:00:00.000Z"

function writeCallLog(root: string, events: readonly SourceCallEvent[]): void {
  const layout = archiveLayout(root)
  writeFileSync(
    sourceCallLogPath(layout),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  )
}

async function writePeak(args: Readonly<{
  root: string
  sourceId: string
  token: string
  mentionedAt: string
}>): Promise<void> {
  const layout = archiveLayout(args.root)
  await writeOutcomeObservation(layout, {
    schema: 1,
    subjectType: "source-call",
    subjectId: `${args.sourceId}:${args.token}`,
    horizonHours: 1,
    observationSpecVersion: 2,
    status: "complete",
    eventTs: args.mentionedAt,
    excessReturn: 0.25,
    observedAt: OBSERVED,
  })
}

describe("loadSourceCallOutcomes", () => {
  it("keeps all outcomes when the call log is empty", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-src-out-empty-"))
    mkdirSync(archiveLayout(root).outcomes, { recursive: true })
    await writePeak({
      root,
      sourceId: "x_alpha",
      token: TOKEN_FOMO,
      mentionedAt: MENTION,
    })
    const loaded = loadSourceCallOutcomes(archiveLayout(root))
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.tokenId).toBe(`x_alpha:${TOKEN_FOMO}`)
  })

  it("drops FOMO-keyed outcomes when the call log has matching FOMO events", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-src-out-filter-"))
    mkdirSync(archiveLayout(root).root, { recursive: true })
    const xEvent: SourceCallEvent = {
      schema: 1,
      eventId: "sc_x_alpha_1",
      sourceId: "x_alpha",
      provenance: "twitter:@alpha",
      rawAddress: TOKEN_X,
      chainHint: "solana",
      mentionedAt: MENTION,
      parserVersion: 1,
      rawItemHash: sha256Json({ n: 1 }),
    }
    const fomoEvent: SourceCallEvent = {
      schema: 1,
      eventId: "sc_fomo_alpha_1",
      sourceId: "x_alpha",
      provenance: "fomo-profile:@alpha",
      rawAddress: TOKEN_FOMO,
      chainHint: "solana",
      mentionedAt: MENTION,
      parserVersion: 1,
      rawItemHash: sha256Json({ n: 2 }),
    }
    writeCallLog(root, [xEvent, fomoEvent])
    await writePeak({
      root,
      sourceId: "x_alpha",
      token: TOKEN_X,
      mentionedAt: MENTION,
    })
    await writePeak({
      root,
      sourceId: "x_alpha",
      token: TOKEN_FOMO,
      mentionedAt: MENTION,
    })
    const loaded = loadSourceCallOutcomes(archiveLayout(root))
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.tokenId).toBe(`x_alpha:${TOKEN_X}`)
  })
})
