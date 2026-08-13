import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RouterEvent } from "../../src/contracts/schemas.js"
import {
  emptyMarketClaimIndex,
  saveMarketClaimIndex,
  upsertMarketClaim,
  type MarketClaimRecord,
} from "../../src/orchestrator/market-claims.js"
import { runPostFixClaimAudit } from "../../src/remediation/post-fix-audit.js"
import { remediationLayout } from "../../src/remediation/paths.js"
import {
  SOURCE_KIND_X_HOME_FYP,
  appendSourceHealthObservation,
  classifyXScanObservation,
  emptySourceHealthLedger,
} from "../../src/remediation/source-health.js"
import { createRemediationStore } from "../../src/remediation/store.js"
import type { RemediationIncident } from "../../src/remediation/schemas.js"
import { loadIntegrityHold } from "../../src/remediation/integrity-hold.js"

const COMMIT = "abcdef1234567"
const DEPLOYED_AT = "2026-07-21T01:00:00.000Z"
const EVENT_ID = "sha256:" + "2".repeat(64)
const CLAIM_REF = "archive/runs/run-int/inbox/fyp.json"

async function setupFixture(args?: Readonly<{ incidentId?: string }>) {
  const home = mkdtempSync(join(tmpdir(), "tc-pfx-int-"))
  const agentRoot = join(home, "agent")
  const archiveRoot = join(home, "archive")
  mkdirSync(join(agentRoot, "state"), { recursive: true, mode: 0o700 })
  mkdirSync(join(home, "remediations", "artifacts"), { recursive: true, mode: 0o700 })
  const layout = remediationLayout(home)
  const store = createRemediationStore(layout)

  let ledger = emptySourceHealthLedger()
  const obs = [
    classifyXScanObservation({
      targetKind: "home",
      targetLabel: "home",
      observedAt: "2026-07-20T10:00:00.000Z",
      postCount: 6,
      hitCursor: false,
      challenged: false,
      sourceCommit: "oldcommit111",
    }),
    classifyXScanObservation({
      targetKind: "home",
      targetLabel: "home",
      observedAt: "2026-07-20T12:00:00.000Z",
      postCount: 0,
      hitCursor: false,
      challenged: false,
    }),
    classifyXScanObservation({
      targetKind: "home",
      targetLabel: "home",
      observedAt: "2026-07-21T02:00:00.000Z",
      postCount: 4,
      hitCursor: false,
      challenged: false,
      sourceCommit: COMMIT,
      runId: "run-recover-a",
    }),
    classifyXScanObservation({
      targetKind: "home",
      targetLabel: "home",
      observedAt: "2026-07-21T03:00:00.000Z",
      postCount: 5,
      hitCursor: false,
      challenged: false,
      sourceCommit: COMMIT,
      runId: "run-recover-b",
    }),
  ]
  for (const o of obs) ledger = appendSourceHealthObservation(ledger, o)
  await store.saveSourceHealthLedger(ledger)

  const claimId = "mc_b_" + "i".repeat(24)
  const claim: MarketClaimRecord = {
    schema: 1,
    claimId,
    kind: "broadcast",
    runId: "run-int",
    occurredAt: "2026-07-20T13:00:00.000Z",
    subject: "sol-memes",
    summary: "FYP-backed peaking call",
    eventId: EVENT_ID,
    provenanceIds: [],
    refs: [CLAIM_REF],
    destinations: ["telegram", "discord"],
  }
  let index = emptyMarketClaimIndex()
  index = upsertMarketClaim(index, claim)
  await saveMarketClaimIndex(agentRoot, index)

  const incident: RemediationIncident = {
    schema: 1,
    incidentId: args?.incidentId ?? "rem-intpostfix01",
    fingerprint: "fp-int-postfix-01",
    phase: "deployed",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-21T01:00:00.000Z",
    title: "empty FYP",
    severity: "warn",
    attemptCount: 1,
    originMoveRebuilds: 0,
    preReviewReviseCount: 0,
    evidencePaths: [],
    proposedPaths: ["src/collectors/twitter/scrape.ts"],
    affectedSources: [SOURCE_KIND_X_HOME_FYP],
    deployedAt: DEPLOYED_AT,
  }

  return { home, agentRoot, archiveRoot, layout, store, incident, claimId }
}

function mockSession(verdict: "stands" | "invalidated" | "inconclusive") {
  return async (args: Readonly<{ prompt: string; message: string }>) => {
    const claimId = /claimId=(\S+)/u.exec(args.message)?.[1] ?? "mc_b_" + "i".repeat(24)
    const allowRaw = /allowlistedEvidence=([^\n]*)/u.exec(args.message)?.[1] ?? ""
    const allow = allowRaw.split(",").map((s) => s.trim()).filter(Boolean)
    const ref = allow.includes(CLAIM_REF) ? CLAIM_REF : (allow[0] ?? CLAIM_REF)
    return JSON.stringify({
      schema: 1,
      claimId,
      verdict,
      reason: `mock-${verdict}`,
      evidenceRefs: verdict === "inconclusive" ? [] : [ref],
      uncertainty: verdict === "inconclusive" ? ["need-more-data"] : [],
    })
  }
}

const auditConfig = {
  enabled: true,
  requiredHealthyObservations: 2,
  maxRounds: 3,
  maxWaitHours: 24 * 365,
  autoCorrect: true,
}

describe("post-fix claim audit integration", () => {
  it("invalidates broadcast in impact window and stages dual-channel correction", async () => {
    const { home, agentRoot, archiveRoot, layout, store, incident, claimId } = await setupFixture()

    const result = await runPostFixClaimAudit({
      layout,
      store,
      incident,
      agentRoot,
      archiveRoot,
      config: auditConfig,
      sourceCommit: COMMIT,
      deployedAt: DEPLOYED_AT,
      home,
      runSession: mockSession("invalidated"),
    })

    expect(result.phase).toBe("completed")
    expect(result.detail).toBe("corrected")
    expect(result.correctionEventIds).toHaveLength(1)
    expect(result.invalidated).toBe(1)

    const outboxDir = join(archiveRoot, "router-outbox", `remediation-${incident.incidentId}`)
    const files = readdirSync(outboxDir).filter((n) => n.endsWith(".json"))
    expect(files).toHaveLength(1)
    const event = JSON.parse(readFileSync(join(outboxDir, files[0]!), "utf8")) as RouterEvent
    expect(event.type).toBe("finding.correction")
    expect(event.channels?.telegram).toBeDefined()
    expect(event.channels?.discord).toBeDefined()
    expect(event.correction?.invalidatedClaimIds).toContain(claimId)
  })

  it("all stands → no correction outbox", async () => {
    const { home, agentRoot, archiveRoot, layout, store, incident } = await setupFixture({
      incidentId: "rem-intpostfix02",
    })

    const result = await runPostFixClaimAudit({
      layout,
      store,
      incident,
      agentRoot,
      archiveRoot,
      config: auditConfig,
      sourceCommit: COMMIT,
      deployedAt: DEPLOYED_AT,
      home,
      runSession: mockSession("stands"),
    })

    expect(result.phase).toBe("completed")
    expect(result.detail).toBe("all-claims-stand")
    expect(result.correctionEventIds).toBeUndefined()
    expect(readdirSync(join(archiveRoot, "router-outbox"), { withFileTypes: true })
      .filter((d) => d.isDirectory())).toHaveLength(0)
  })

  it("invalidated decision only → no public correction", async () => {
    const { home, agentRoot, archiveRoot, layout, store, incident } = await setupFixture({
      incidentId: "rem-intpostfix-internal",
    })
    const internalOnly: MarketClaimRecord = {
      schema: 1,
      claimId: "mc_d_" + "d".repeat(24),
      kind: "decision",
      runId: "run-int",
      occurredAt: "2026-07-20T13:00:00.000Z",
      subject: "sol:TokenInternal111111111111111111111111111",
      summary: "track during empty FYP",
      decisionId: "dec-internal-1",
      verdict: "track",
      provenanceIds: [],
      refs: [CLAIM_REF],
      destinations: [],
    }
    let index = emptyMarketClaimIndex()
    index = upsertMarketClaim(index, internalOnly)
    await saveMarketClaimIndex(agentRoot, index)

    const result = await runPostFixClaimAudit({
      layout,
      store,
      incident,
      agentRoot,
      archiveRoot,
      config: auditConfig,
      sourceCommit: COMMIT,
      deployedAt: DEPLOYED_AT,
      home,
      runSession: mockSession("invalidated"),
    })

    expect(result.phase).toBe("completed")
    expect(result.detail).toBe("invalidated-internal-only")
    expect(result.correctionEventIds).toBeUndefined()
    expect(result.invalidated).toBe(1)
    expect(readdirSync(join(archiveRoot, "router-outbox"), { withFileTypes: true })
      .filter((d) => d.isDirectory())).toHaveLength(0)
  }, 15_000)

  it("inconclusive → awaiting-recovery-data then attention after max rounds", async () => {
    const { home, agentRoot, archiveRoot, layout, store, incident } = await setupFixture({
      incidentId: "rem-intpostfix03",
    })

    const first = await runPostFixClaimAudit({
      layout,
      store,
      incident,
      agentRoot,
      archiveRoot,
      config: { ...auditConfig, maxRounds: 2 },
      sourceCommit: COMMIT,
      deployedAt: DEPLOYED_AT,
      home,
      runSession: mockSession("inconclusive"),
    })
    expect(first.phase).toBe("awaiting-recovery-data")
    expect(first.detail).toMatch(/inconclusive-retry-round:1/)
    expect(loadIntegrityHold(home)?.incidentId).toBe(incident.incidentId)

    const second = await runPostFixClaimAudit({
      layout,
      store,
      incident: { ...incident, revalidationRound: first.revalidationRound },
      agentRoot,
      archiveRoot,
      config: { ...auditConfig, maxRounds: 2 },
      sourceCommit: COMMIT,
      deployedAt: DEPLOYED_AT,
      home,
      runSession: mockSession("inconclusive"),
    })
    expect(second.phase).toBe("attention-required")
    expect(second.detail).toMatch(/inconclusive-exhausted-rounds/)
    expect(loadIntegrityHold(home)).toBeUndefined()
  })

  it("skips wait and does not hold when source kinds have no ledger rows", async () => {
    const { home, agentRoot, archiveRoot, layout, store } = await setupFixture({
      incidentId: "rem-intpostfix-market",
    })
    await store.saveSourceHealthLedger(emptySourceHealthLedger())
    const incident: RemediationIncident = {
      schema: 1,
      incidentId: "rem-intpostfix-market",
      fingerprint: "fp-int-postfix-market",
      phase: "deployed",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-21T01:00:00.000Z",
      title: "discord live tape",
      severity: "info",
      attemptCount: 1,
      originMoveRebuilds: 0,
      preReviewReviseCount: 0,
      evidencePaths: [],
      proposedPaths: ["src/collectors/market/providers.ts", "src/discord/live-tape.ts"],
      deployedAt: DEPLOYED_AT,
    }

    const result = await runPostFixClaimAudit({
      layout,
      store,
      incident,
      agentRoot,
      archiveRoot,
      config: auditConfig,
      sourceCommit: COMMIT,
      deployedAt: DEPLOYED_AT,
      home,
    })

    expect(result.phase).toBe("attention-required")
    expect(result.detail).toBe("no-source-health-observations:coingecko,dexscreener")
    expect(loadIntegrityHold(home)).toBeUndefined()
  })

  it("releases the hold when recovery wait is exhausted", async () => {
    const { home, agentRoot, archiveRoot, layout, store } = await setupFixture({
      incidentId: "rem-intpostfix-wait",
    })
    let ledger = emptySourceHealthLedger()
    ledger = appendSourceHealthObservation(ledger, classifyXScanObservation({
      targetKind: "home",
      targetLabel: "home",
      observedAt: "2026-07-20T10:00:00.000Z",
      postCount: 0,
      hitCursor: false,
      challenged: false,
    }))
    await store.saveSourceHealthLedger(ledger)
    const incident: RemediationIncident = {
      schema: 1,
      incidentId: "rem-intpostfix-wait",
      fingerprint: "fp-int-postfix-wait",
      phase: "deployed",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-21T01:00:00.000Z",
      title: "empty FYP",
      severity: "warn",
      attemptCount: 1,
      originMoveRebuilds: 0,
      preReviewReviseCount: 0,
      evidencePaths: [],
      proposedPaths: ["docs/architecture/discord-conversation.md"],
      affectedSources: [SOURCE_KIND_X_HOME_FYP],
      deployedAt: DEPLOYED_AT,
    }

    const result = await runPostFixClaimAudit({
      layout,
      store,
      incident,
      agentRoot,
      archiveRoot,
      config: { ...auditConfig, maxWaitHours: 24 },
      sourceCommit: COMMIT,
      deployedAt: DEPLOYED_AT,
      home,
    })

    expect(result.phase).toBe("attention-required")
    expect(result.detail).toMatch(/^recovery-wait-exhausted:/u)
    expect(loadIntegrityHold(home)).toBeUndefined()
  })
})
