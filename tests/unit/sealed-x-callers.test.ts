import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveLayout } from "../../src/lib/archive.js"
import { sha256Json } from "../../src/lib/canonical-json.js"
import type { SourceCallEvent, SourceLifecycleFile } from "../../src/contracts/schemas.js"
import {
  loadDiscoverySightingsFromArchive,
  registerSealedXCallers,
  strongXCallersFromLog,
} from "../../src/sources/sealed-x-callers.js"

const NOW = "2026-08-17T08:00:00.000Z"

function emptyFile(): SourceLifecycleFile {
  return {
    schema: 1,
    candidates: [],
    transitions: [],
    pendingTransitionIds: [],
  }
}

function mint(n: number): string {
  return `So11111111111111111111111111111111111111${String(n).padStart(2, "0")}`
}

function xEvent(handle: string, n: number, tokenIndex: number): SourceCallEvent {
  return {
    schema: 1,
    eventId: `sc_${handle}_${n}`,
    sourceId: `x_${handle.toLowerCase()}`,
    provenance: `twitter:@${handle}`,
    rawAddress: mint(tokenIndex),
    chainHint: "solana",
    mentionedAt: `2026-08-0${1 + (n % 7)}T12:00:00.000Z`,
    parserVersion: 1,
    rawItemHash: sha256Json({ handle, n }),
  }
}

function fomoEvent(handle: string, n: number): SourceCallEvent {
  return {
    ...xEvent(handle, n, n % 5),
    eventId: `sc_fomo_${handle}_${n}`,
    provenance: `fomo-profile:@${handle}`,
  }
}

function strongEvents(handle: string): SourceCallEvent[] {
  return Array.from({ length: 10 }, (_, i) => xEvent(handle, i, i % 5))
}

describe("strongXCallersFromLog", () => {
  it("keeps X-post callers at the 10/5 bar", () => {
    const strong = strongXCallersFromLog(strongEvents("viking"))
    expect(strong.get("x_viking")).toEqual({
      handle: "viking",
      calls: 10,
      tokens: 5,
    })
  })

  it("ignores FOMO profile provenance", () => {
    const events = Array.from({ length: 10 }, (_, i) => fomoEvent("alpha", i))
    expect(strongXCallersFromLog(events).size).toBe(0)
  })
})

describe("registerSealedXCallers", () => {
  it("registers a strong caller who appears on a sealed FYP snapshot", () => {
    const result = registerSealedXCallers(emptyFile(), {
      events: strongEvents("viking"),
      sightings: [{ handle: "viking", origin: "fyp" }],
      nowIso: NOW,
    })
    expect(result.report.registered).toBe(1)
    expect(result.file.candidates[0]?.sourceId).toBe("x_viking")
    expect(result.file.candidates[0]?.discoveredFrom).toBe("fyp")
  })

  it("does not register a strong caller without a sealed sighting", () => {
    const result = registerSealedXCallers(emptyFile(), {
      events: strongEvents("viking"),
      sightings: [],
      nowIso: NOW,
    })
    expect(result.report.registered).toBe(0)
    expect(result.file.candidates).toHaveLength(0)
  })
})

describe("loadDiscoverySightingsFromArchive", () => {
  it("maps home snapshots to fyp", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-sealed-x-"))
    const layout = archiveLayout(root)
    const inbox = join(layout.runs, "list-scan-2026-08-17T00-00-00-000Z", "inbox")
    mkdirSync(inbox, { recursive: true })
    writeFileSync(join(inbox, "twitter-home.json"), `${JSON.stringify({
      source: "twitter.home",
      fetchedAt: NOW,
      trust: "untrusted-external",
      items: [{
        provenance: "twitter:@viking",
        text: "hello",
        ts: NOW,
        ageSec: 0,
        freshnessTier: "live",
      }],
    })}\n`)
    expect(loadDiscoverySightingsFromArchive(layout)).toEqual([
      { handle: "viking", origin: "fyp" },
    ])
  })
})
