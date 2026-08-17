import { describe, expect, it } from "vitest"
import {
  assertNarrativeDevelopmentAllowed,
  developmentCatalystEntities,
  developmentSalientTokens,
  isSameCatalystRewrite,
  normalizeCatalystEntity,
} from "../../src/orchestrator/narrative-development.js"
import type { NarrativeLogEntry } from "../../src/orchestrator/narrative-log.js"
import type { MarketClaimRecord } from "../../src/orchestrator/market-claims.js"
import type { BroadcastItem } from "../../src/contracts/schemas.js"

const NOW = "2026-07-21T19:00:00.000Z"

const RH: NarrativeLogEntry = {
  slug: "rh-chain-meme-rotation",
  title: "Robinhood chain meme rotation",
  firstSeen: "2026-07-18T11:00:00.000Z",
  lastSeen: "2026-07-21T05:00:00.000Z",
  evidence: ["twitter:@alice"],
  stage: "peaking",
}

function development(text: string, subject = RH.slug): BroadcastItem {
  return {
    severity: "notable",
    text,
    refs: ["state/narratives/log.jsonl"],
    auditClaim: {
      type: "narrative-development",
      subject,
      direction: "rotation",
      horizonHours: 72,
      verificationRule: "narrative.development",
    },
  }
}

function priorClaim(
  summary: string,
  occurredAt: string,
  auditClaimType = "narrative-development",
): MarketClaimRecord {
  return {
    schema: 1,
    claimId: "mc_b_priorpriorprior",
    kind: "broadcast",
    runId: "list-scan-prior",
    occurredAt,
    subject: RH.slug,
    summary,
    auditClaimType,
    provenanceIds: [],
    refs: [],
    destinations: ["telegram"],
  }
}

const LIST_SCAN_STOCKCOIN =
  "Stock-token meta sprouting a Base branch. longdotxyz team shipping cleaner launch UX with 200 tokens already listed. CT tying first Base stock pool to Cobie-adjacent AERO liquidity. Early, mostly social."
const NARRATIVE_SCAN_STOCKCOIN =
  "Stock token infra expanding on Base. long.xyz dev shipping UX for 200 equity tokens today. First Base stock token getting Cobie timeline heat. StackersXYZ going loud on NFT+token pairing."
const COINBASE_STOCKCOIN =
  "Stockcoin meta keeps stretching. CT claims first Coinbase stock token pair on Ethereum with a fresh CA. Another chain branch if liquidity does not ghost."

describe("developmentCatalystEntities", () => {
  it("folds long.xyz and longdotxyz onto one key", () => {
    expect(normalizeCatalystEntity("long.xyz")).toBe("longxyz")
    expect(normalizeCatalystEntity("longdotxyz")).toBe("longxyz")
    const dotted = developmentCatalystEntities("long.xyz shipped UX on Base. Cobie tape.")
    const glued = developmentCatalystEntities("longdotxyz shipped UX on Base. Cobie tape.")
    expect(dotted.has("longxyz")).toBe(true)
    expect(glued.has("longxyz")).toBe(true)
    expect(dotted.has("base")).toBe(true)
    expect(dotted.has("cobie")).toBe(true)
  })

  it("treats the live Stockcoin rewrite as the same catalyst", () => {
    expect(isSameCatalystRewrite(NARRATIVE_SCAN_STOCKCOIN, LIST_SCAN_STOCKCOIN)).toBe(true)
  })

  it("keeps a later Coinbase or Ethereum branch eligible", () => {
    expect(isSameCatalystRewrite(COINBASE_STOCKCOIN, LIST_SCAN_STOCKCOIN)).toBe(false)
  })
})

describe("developmentSalientTokens", () => {
  it("captures cashtags, caps tickers, and distinctive words", () => {
    const tokens = developmentSalientTokens(
      "vlad says agents can trade on rh chain now. $CASHCAT & WOOD leading",
    )
    expect([...tokens]).toEqual(
      expect.arrayContaining(["vlad", "cashcat", "wood", "agents", "trade"]),
    )
    expect(tokens.has("the")).toBe(false)
    expect(tokens.has("rotation")).toBe(false)
  })
})

describe("assertNarrativeDevelopmentAllowed", () => {
  it("ignores non-development claims", () => {
    const item = {
      ...development("whatever"),
      auditClaim: {
        ...development("whatever").auditClaim,
        type: "token-upside" as const,
        direction: "up" as const,
        verificationRule: "token.up.72h",
      },
    }
    expect(assertNarrativeDevelopmentAllowed({
      item,
      narrativeLog: [],
      recentClaims: [],
      nowIso: NOW,
    })).toEqual({ ok: true })
  })

  it("rejects developments on unknown narratives", () => {
    const res = assertNarrativeDevelopmentAllowed({
      item: development("brand new catalyst", "not-a-known-slug"),
      narrativeLog: [RH],
      recentClaims: [],
      nowIso: NOW,
    })
    expect(res).toEqual({
      ok: false,
      reason: "development-unknown-narrative:use-narrative-emergence",
    })
  })

  it("allows a product catalyst inside a peaking narrative", () => {
    const res = assertNarrativeDevelopmentAllowed({
      item: development("vlad: your agent can trade on rh chain now. product catalyst, watch flows"),
      narrativeLog: [RH],
      recentClaims: [],
      nowIso: NOW,
    })
    expect(res).toEqual({ ok: true })
  })

  it("dedupes legacy same-stage emergence claims as developments", () => {
    const item: BroadcastItem = {
      ...development("PONS protocol revenue jumped to $169K while FDV held $26M"),
      auditClaim: {
        type: "narrative-emergence",
        subject: "rh-chain-meme-rotation",
        direction: "up",
        horizonHours: 72,
        verificationRule: "narrative.emergence",
      },
    }
    expect(assertNarrativeDevelopmentAllowed({
      item,
      narrativeLog: [RH],
      recentClaims: [
        priorClaim("PONS founder follow pushed the token toward $40M", "2026-07-21T10:00:00.000Z"),
      ],
      nowIso: NOW,
      sameStageDevelopment: true,
    })).toEqual({ ok: true })
  })

  it("rejects a reworded same-catalyst development on the same subject", () => {
    const res = assertNarrativeDevelopmentAllowed({
      item: development(NARRATIVE_SCAN_STOCKCOIN, "stockcoin-meta"),
      narrativeLog: [{
        ...RH,
        slug: "stockcoin-meta",
        title: "Stockcoin meta",
      }],
      recentClaims: [
        {
          ...priorClaim(LIST_SCAN_STOCKCOIN, "2026-07-21T10:00:00.000Z"),
          subject: "stockcoin-meta",
        },
      ],
      nowIso: NOW,
    })
    expect(res).toEqual({ ok: false, reason: "development-same-catalyst" })
  })

  it("rejects a repeat of a recent development on the same subject", () => {
    const res = assertNarrativeDevelopmentAllowed({
      item: development("vlad agent trading catalyst on rh, $CASHCAT leading"),
      narrativeLog: [RH],
      recentClaims: [
        priorClaim(
          "vlad says agents can trade now, catalyst for rh. $CASHCAT leading",
          "2026-07-21T10:00:00.000Z",
        ),
      ],
      nowIso: NOW,
    })
    expect(res).toEqual({ ok: false, reason: "development-repeats-recent-broadcast" })
  })

  it("allows new names entering a rotation after an earlier development", () => {
    const res = assertNarrativeDevelopmentAllowed({
      item: development("rh rotation names moving: $SUSHICAT & $WISHBONE in, $CASHCAT cooling"),
      narrativeLog: [RH],
      recentClaims: [
        priorClaim("$CASHCAT & $HOODRAT leading rh names", "2026-07-21T10:00:00.000Z"),
      ],
      nowIso: NOW,
    })
    expect(res).toEqual({ ok: true })
  })

  it("forgets prior developments outside the 48h window", () => {
    const res = assertNarrativeDevelopmentAllowed({
      item: development("vlad agent trading catalyst on rh, $CASHCAT leading"),
      narrativeLog: [RH],
      recentClaims: [
        priorClaim(
          "vlad says agents can trade now, catalyst. $CASHCAT leading",
          "2026-07-18T10:00:00.000Z",
        ),
      ],
      nowIso: NOW,
    })
    expect(res).toEqual({ ok: true })
  })
})
