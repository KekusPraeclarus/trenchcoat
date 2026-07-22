import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RouterEvent } from "../../src/contracts/schemas.js"
import { ensureArchive, runArchiveDir } from "../../src/lib/archive.js"
import {
  broadcastClaimId,
  claimsInImpactWindow,
  decisionClaimId,
  emptyMarketClaimIndex,
  emptyMarketClaimValidityIndex,
  extractBroadcastClaimsFromArchive,
  isClaimIgnoredByValidity,
  narrativeClaimId,
  recordFromBroadcastEvent,
  recordFromNarrativeTransition,
  upsertClaimValidity,
  upsertMarketClaim,
  type MarketClaimRecord,
} from "../../src/orchestrator/market-claims.js"

const EVENT_A = "sha256:" + "a".repeat(64)
const EVENT_B = "sha256:" + "b".repeat(64)

function broadcastEvent(overrides?: Partial<RouterEvent>): RouterEvent {
  return {
    schema: 1,
    eventId: EVENT_A,
    occurredAt: "2026-07-21T02:30:00.000Z",
    runId: "run-claims-1",
    type: "finding.broadcast",
    severity: "info",
    text: "SOL narrative peaking — watch entries",
    refs: ["reports/run-claims-1/evidence.json"],
    auditClaim: {
      type: "narrative-emergence",
      subject: "sol-memes",
      direction: "up",
      horizonHours: 24,
      verificationRule: "price-above-entry",
    },
    ...overrides,
  }
}

describe("claim IDs", () => {
  it("are stable for broadcast / narrative / decision", () => {
    expect(broadcastClaimId(EVENT_A)).toBe(broadcastClaimId(EVENT_A))
    expect(broadcastClaimId(EVENT_A)).not.toBe(broadcastClaimId(EVENT_B))
    expect(broadcastClaimId(EVENT_A).startsWith("mc_b_")).toBe(true)

    const nArgs = {
      runId: "run-1",
      slug: "ai-agents",
      stage: "peaking",
      lastSeen: "2026-07-21T01:00:00.000Z",
    }
    expect(narrativeClaimId(nArgs)).toBe(narrativeClaimId(nArgs))
    expect(narrativeClaimId(nArgs).startsWith("mc_n_")).toBe(true)

    const dArgs = { runId: "run-1", decisionId: "dec-abc" }
    expect(decisionClaimId(dArgs)).toBe(decisionClaimId(dArgs))
    expect(decisionClaimId(dArgs).startsWith("mc_d_")).toBe(true)
  })
})

describe("upsertMarketClaim", () => {
  it("upserts by claimId without duplicating", () => {
    const claim = recordFromBroadcastEvent({
      event: broadcastEvent(),
      destinations: ["telegram"],
    })!
    let index = emptyMarketClaimIndex()
    index = upsertMarketClaim(index, claim)
    index = upsertMarketClaim(index, { ...claim, summary: "updated summary" })
    expect(index.claims).toHaveLength(1)
    expect(index.claims[0]?.summary).toBe("updated summary")
  })
})

describe("claim validity", () => {
  it("marks invalidated and already-superseded as ignored", () => {
    let validity = emptyMarketClaimValidityIndex()
    validity = upsertClaimValidity(validity, {
      schema: 1,
      claimId: "mc_b_" + "1".repeat(24),
      validity: "invalidated",
      updatedAt: "2026-07-21T05:00:00.000Z",
      reason: "revalidated-false",
    })
    validity = upsertClaimValidity(validity, {
      schema: 1,
      claimId: "mc_b_" + "2".repeat(24),
      validity: "already-superseded",
      updatedAt: "2026-07-21T05:00:00.000Z",
      supersededBy: "mc_b_" + "3".repeat(24),
    })
    validity = upsertClaimValidity(validity, {
      schema: 1,
      claimId: "mc_b_" + "4".repeat(24),
      validity: "stands",
      updatedAt: "2026-07-21T05:00:00.000Z",
    })
    expect(isClaimIgnoredByValidity(validity, "mc_b_" + "1".repeat(24))).toBe(true)
    expect(isClaimIgnoredByValidity(validity, "mc_b_" + "2".repeat(24))).toBe(true)
    expect(isClaimIgnoredByValidity(validity, "mc_b_" + "4".repeat(24))).toBe(false)
  })
})

describe("claimsInImpactWindow", () => {
  it("uses exclusive start and inclusive end", () => {
    const start = "2026-07-21T01:00:00.000Z"
    const end = "2026-07-21T04:00:00.000Z"
    const base: Omit<MarketClaimRecord, "claimId" | "occurredAt"> = {
      schema: 1,
      kind: "broadcast",
      runId: "run-1",
      subject: "sol",
      summary: "s",
      provenanceIds: [],
      refs: [],
      destinations: ["telegram"],
    }
    const claims: MarketClaimRecord[] = [
      { ...base, claimId: "mc_b_" + "a".repeat(24), occurredAt: start },
      { ...base, claimId: "mc_b_" + "b".repeat(24), occurredAt: "2026-07-21T02:00:00.000Z" },
      { ...base, claimId: "mc_b_" + "c".repeat(24), occurredAt: end },
      { ...base, claimId: "mc_b_" + "d".repeat(24), occurredAt: "2026-07-21T04:00:00.001Z" },
    ]
    const hit = claimsInImpactWindow({
      claims,
      startExclusive: start,
      endInclusive: end,
    })
    expect(hit.map((c) => c.claimId)).toEqual([
      "mc_b_" + "b".repeat(24),
      "mc_b_" + "c".repeat(24),
    ])
  })
})

describe("recordFromBroadcastEvent", () => {
  it("indexes finding.broadcast with destinations", () => {
    const record = recordFromBroadcastEvent({
      event: broadcastEvent(),
      destinations: ["telegram", "discord"],
    })
    expect(record).toBeDefined()
    expect(record!.claimId).toBe(broadcastClaimId(EVENT_A))
    expect(record!.kind).toBe("broadcast")
    expect(record!.subject).toBe("sol-memes")
    expect(record!.destinations).toEqual(["telegram", "discord"])
    expect(record!.eventId).toBe(EVENT_A)
  })

  it("returns undefined for non-broadcast events", () => {
    expect(recordFromBroadcastEvent({
      event: {
        ...broadcastEvent(),
        type: "finding.correction",
        severity: "info",
        correction: {
          incidentId: "rem-aaaaaaaaaaaa",
          invalidatedClaimIds: ["mc_b_" + "x".repeat(24)],
          originalEventIds: [],
        },
      },
    })).toBeUndefined()
  })
})

describe("extractBroadcastClaimsFromArchive", () => {
  it("requires an accepted ingress receipt in acceptedOnly mode", async () => {
    const layout = await ensureArchive(mkdtempSync(join(tmpdir(), "tc-claims-")))
    const event = broadcastEvent({
      channels: {
        telegram: { text: "SOL moved" },
        discord: { text: "SOL moved" },
      },
    })
    const outbox = join(layout.routerOutbox, event.runId)
    mkdirSync(outbox, { recursive: true })
    writeFileSync(join(outbox, "event.json"), `${JSON.stringify(event)}\n`)

    const query = {
      layout,
      startExclusive: "2026-07-21T00:00:00.000Z",
      endInclusive: "2026-07-21T03:00:00.000Z",
      acceptedOnly: true,
    } as const
    expect(extractBroadcastClaimsFromArchive(query)).toEqual([])

    const runDir = runArchiveDir(layout, event.runId)
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, "delivery-receipts.json"), `${JSON.stringify({
      receipts: [{ eventId: event.eventId, status: "accepted" }],
    })}\n`)

    expect(extractBroadcastClaimsFromArchive(query)[0]?.destinations).toEqual([
      "telegram",
      "discord",
    ])
  })
})

describe("recordFromNarrativeTransition", () => {
  it("emits only on stage change", () => {
    const after = {
      slug: "ai-agents",
      title: "AI Agents",
      stage: "peaking" as const,
      firstSeen: "2026-07-21T01:00:00.000Z",
      lastSeen: "2026-07-21T02:00:00.000Z",
      evidence: ["e1"],
      sourceProvenanceIds: ["p1"],
    }
    expect(recordFromNarrativeTransition({
      runId: "run-1",
      before: { ...after, stage: "peaking" },
      after,
    })).toBeUndefined()
    const changed = recordFromNarrativeTransition({
      runId: "run-1",
      before: { ...after, stage: "emerging" },
      after,
    })
    expect(changed?.kind).toBe("narrative-stage")
    expect(changed?.priorStage).toBe("emerging")
  })
})
