import { describe, expect, it } from "vitest"
import {
  assertNarrativeBroadcastAllowed,
  narrativeAliases,
  restatesUnchangedNarrativeStage,
  statusQuoNarratives,
} from "../../src/orchestrator/narrative-stage-dedupe.js"
import type { NarrativeLogEntry } from "../../src/orchestrator/narrative-log.js"

const RH: NarrativeLogEntry = {
  slug: "rh-chain-meme-rotation",
  title: "Robinhood chain meme rotation",
  firstSeen: "2026-07-18T11:00:00.000Z",
  lastSeen: "2026-07-18T18:00:00.000Z",
  evidence: ["twitter:@alice"],
  stage: "peaking",
}

describe("statusQuoNarratives", () => {
  it("keeps unchanged heat and drops stage transitions", () => {
    const after: NarrativeLogEntry[] = [
      { ...RH, stage: "fading" },
      {
        slug: "jimothy-sol-meme",
        title: "Jimothy SOL meme surge",
        firstSeen: "2026-07-18T18:00:00.000Z",
        lastSeen: "2026-07-18T18:00:00.000Z",
        evidence: ["twitter:@bob"],
        stage: "emerging",
      },
    ]
    const before: NarrativeLogEntry[] = [
      RH,
      {
        slug: "jimothy-sol-meme",
        title: "Jimothy SOL meme surge",
        firstSeen: "2026-07-18T18:00:00.000Z",
        lastSeen: "2026-07-18T18:00:00.000Z",
        evidence: ["twitter:@bob"],
        stage: "emerging",
      },
    ]
    const quo = statusQuoNarratives(before, after)
    expect(quo.map((e) => e.slug)).toEqual(["jimothy-sol-meme"])
  })
})

describe("restatesUnchangedNarrativeStage", () => {
  it("flags RH peaking restatements", () => {
    const quo = statusQuoNarratives([RH])
    expect(narrativeAliases(quo[0]!)).toEqual(
      expect.arrayContaining(["rh", "robinhood", "rotation"]),
    )
    expect(restatesUnchangedNarrativeStage(
      "rh rotation still peaking. fyp has cashcat perps war",
      quo,
    )).toBe(true)
    expect(restatesUnchangedNarrativeStage(
      "RH chain meme rotation bumped to peaking on this scan",
      quo,
    )).toBe(true)
  })

  it("allows novel lanes that do not restate known heat", () => {
    const quo = statusQuoNarratives([RH])
    expect(restatesUnchangedNarrativeStage(
      "jimothy sol meme popping on ct. warcraft & mlb posts",
      quo,
    )).toBe(false)
  })
})

describe("assertNarrativeBroadcastAllowed", () => {
  const item = {
    severity: "watch" as const,
    text: "RH chain meme rotation bumped to peaking",
    refs: ["state/narratives/log.jsonl"],
    auditClaim: {
      type: "narrative-emergence" as const,
      subject: "rh-chain-meme-rotation",
      direction: "up" as const,
      horizonHours: 72,
      verificationRule: "narrative.emergence",
    },
  }

  it("routes unchanged-stage emergence through development dedupe", () => {
    expect(assertNarrativeBroadcastAllowed({
      item,
      logBefore: [RH],
      logAfter: [RH],
    })).toEqual({ ok: true, sameStageDevelopment: true })
  })

  it("allows heat decrease via fade", () => {
    const fading = { ...RH, stage: "fading" as const }
    expect(assertNarrativeBroadcastAllowed({
      item: {
        ...item,
        text: "RH rotation cooling into fade",
        auditClaim: {
          type: "narrative-fade",
          subject: "rh-chain-meme-rotation",
          direction: "down",
          horizonHours: 72,
          verificationRule: "narrative.fade",
        },
      },
      logBefore: [RH],
      logAfter: [fading],
    })).toEqual({ ok: true })
  })

  it("allows brand-new slugs", () => {
    expect(assertNarrativeBroadcastAllowed({
      item: {
        ...item,
        auditClaim: { ...item.auditClaim, subject: "wallet-tibbir-conspiracy" },
      },
      logBefore: [RH],
    })).toEqual({ ok: true })
  })
})

describe("framing on statusQuoNarratives", () => {
  it("carries effective framing on status-quo survivors", () => {
    const mature: NarrativeLogEntry = {
      ...RH,
      title: "RH Chain agent infra",
      framing: "ecosystem",
      framingMaturedAt: RH.lastSeen,
      framingEvidence: ["twitter:@bob:2"],
    }
    const quo = statusQuoNarratives([mature])
    expect(quo[0]).toMatchObject({
      slug: "rh-chain-meme-rotation",
      framing: "ecosystem",
      title: "RH Chain agent infra",
    })
  })
})
