import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  claimHash,
  emptyWorthinessCache,
  loadWorthinessCache,
  lookupWorthinessCache,
  pruneWorthinessCache,
  saveWorthinessCache,
  upsertWorthinessCache,
  WORTHINESS_CACHE_TTL_MS,
} from "../../src/orchestrator/broadcast-worthiness-cache.js"
import { saveMarketClaimIndex } from "../../src/orchestrator/market-claims.js"
import type { AuditClaim } from "../../src/contracts/schemas.js"

const CLAIM: AuditClaim = {
  type: "narrative-emergence",
  subject: "rh-chain-meme-rotation",
  direction: "up",
  horizonHours: 72,
  verificationRule: "narrative.emergence",
}

const NOW = "2026-07-23T12:00:00.000Z"

function agentRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tc-worth-cache-"))
  mkdirSync(join(root, "state", "narratives"), { recursive: true })
  writeFileSync(join(root, "state", "narratives", "log.jsonl"), "")
  return root
}

describe("claimHash", () => {
  it("is stable over lowercased trimmed subject", () => {
    const a = claimHash({ ...CLAIM, subject: " RH-Chain-Meme-Rotation " })
    const b = claimHash({ ...CLAIM, subject: "rh-chain-meme-rotation" })
    expect(a).toBe(b)
    expect(a.startsWith("sha256:")).toBe(true)
  })

  it("changes when type or rule changes", () => {
    expect(claimHash(CLAIM)).not.toBe(
      claimHash({ ...CLAIM, type: "narrative-fade", verificationRule: "narrative.fade" }),
    )
  })
})

describe("worthiness cache", () => {
  it("lookup misses then hits after upsert", async () => {
    const root = agentRoot()
    let cache = emptyWorthinessCache()
    expect(lookupWorthinessCache(cache, {
      subject: CLAIM.subject,
      claimHash: claimHash(CLAIM),
      nowIso: NOW,
    })).toBeUndefined()

    cache = upsertWorthinessCache(cache, {
      auditClaim: CLAIM,
      worth: true,
      reason: "new heat",
      decidedAt: NOW,
    })
    await saveWorthinessCache(root, cache)

    const loaded = loadWorthinessCache(root, { nowIso: NOW })
    const hit = lookupWorthinessCache(loaded, {
      subject: CLAIM.subject,
      claimHash: claimHash(CLAIM),
      nowIso: NOW,
    })
    expect(hit?.worth).toBe(true)
    expect(hit?.reason).toBe("new heat")
  })

  it("prunes expired entries", () => {
    const decidedAt = "2026-07-20T12:00:00.000Z"
    const cache = upsertWorthinessCache(emptyWorthinessCache(), {
      auditClaim: CLAIM,
      worth: false,
      reason: "thin",
      decidedAt,
    })
    const pruned = pruneWorthinessCache(cache, { nowIso: NOW })
    expect(pruned.entries).toHaveLength(0)
  })

  it("sets expiresAt to decidedAt + 48h", () => {
    const cache = upsertWorthinessCache(emptyWorthinessCache(), {
      auditClaim: CLAIM,
      worth: true,
      reason: "ok",
      decidedAt: NOW,
    })
    expect(cache.entries[0]?.expiresAt).toBe(
      new Date(Date.parse(NOW) + WORTHINESS_CACHE_TTL_MS).toISOString(),
    )
  })

  it("invalidates on narrative stage change after decidedAt", async () => {
    const root = agentRoot()
    const decidedAt = "2026-07-22T10:00:00.000Z"
    let cache = upsertWorthinessCache(emptyWorthinessCache(), {
      auditClaim: CLAIM,
      worth: true,
      reason: "cached",
      decidedAt,
    })
    await saveWorthinessCache(root, cache)

    await saveMarketClaimIndex(root, {
      schema: 1,
      claims: [{
        schema: 1,
        claimId: "mc_n_stage",
        kind: "narrative-stage",
        runId: "run",
        occurredAt: "2026-07-22T18:00:00.000Z",
        subject: "rh-chain-meme-rotation",
        summary: "RH → peaking",
        narrativeStage: "peaking",
        priorStage: "emerging",
        provenanceIds: [],
        refs: [],
        destinations: [],
      }],
    })

    const loaded = loadWorthinessCache(root, { nowIso: NOW })
    expect(lookupWorthinessCache(loaded, {
      subject: CLAIM.subject,
      claimHash: claimHash(CLAIM),
      nowIso: NOW,
    })).toBeUndefined()
  })

  it("invalidates from before/after narrative log stage delta", () => {
    const decidedAt = "2026-07-22T10:00:00.000Z"
    const cache = upsertWorthinessCache(emptyWorthinessCache(), {
      auditClaim: CLAIM,
      worth: false,
      reason: "old",
      decidedAt,
    })
    const pruned = pruneWorthinessCache(cache, {
      nowIso: NOW,
      stageChangedAtBySubject: new Map([
        ["rh-chain-meme-rotation", "2026-07-22T15:00:00.000Z"],
      ]),
    })
    expect(pruned.entries).toHaveLength(0)
  })

  it("keeps entries when stage change is before decidedAt", () => {
    const cache = upsertWorthinessCache(emptyWorthinessCache(), {
      auditClaim: CLAIM,
      worth: true,
      reason: "still good",
      decidedAt: "2026-07-22T20:00:00.000Z",
    })
    const pruned = pruneWorthinessCache(cache, {
      nowIso: NOW,
      stageChangedAtBySubject: new Map([
        ["rh-chain-meme-rotation", "2026-07-22T12:00:00.000Z"],
      ]),
    })
    expect(pruned.entries).toHaveLength(1)
  })
})
