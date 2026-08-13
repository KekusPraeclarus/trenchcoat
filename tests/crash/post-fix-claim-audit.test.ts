import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  emptySourceHealthLedger,
} from "../../src/remediation/source-health.js"
import { createRemediationStore } from "../../src/remediation/store.js"
import { loadIntegrityHold } from "../../src/remediation/integrity-hold.js"
import type { RemediationIncident, SourceHealthObservation } from "../../src/remediation/schemas.js"
import type { RouterEvent } from "../../src/contracts/schemas.js"

const COMMIT = "abcdef1234567"
const INCIDENT_ID = "rem-crashfix01"
const EVENT_ID = "sha256:" + "1".repeat(64)
const CLAIM_ID = "mc_b_" + "c".repeat(24)
const CLAIM_REF = "archive/runs/run-crash/inbox/posts.json"

const DEPLOYED_AT = "2026-07-21T01:00:00.000Z"

function baseIncident(overrides?: Partial<RemediationIncident>): RemediationIncident {
  return {
    schema: 1,
    incidentId: INCIDENT_ID,
    fingerprint: "fp-crash-postfix-01",
    phase: "deployed",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-21T01:00:00.000Z",
    title: "empty FYP scrape",
    severity: "warn",
    attemptCount: 1,
    originMoveRebuilds: 0,
    preReviewReviseCount: 0,
    evidencePaths: [],
    proposedPaths: ["src/collectors/twitter/scrape.ts"],
    affectedSources: [SOURCE_KIND_X_HOME_FYP],
    deployedAt: DEPLOYED_AT,
    ...overrides,
  }
}

function claimInWindow(): MarketClaimRecord {
  return {
    schema: 1,
    claimId: CLAIM_ID,
    kind: "broadcast",
    runId: "run-crash",
    occurredAt: "2026-07-20T13:00:00.000Z",
    subject: "sol-memes",
    summary: "peaking call during outage",
    eventId: EVENT_ID,
    provenanceIds: [],
    refs: [CLAIM_REF],
    destinations: ["telegram", "discord"],
  }
}

function observation(partial: Partial<SourceHealthObservation> & Pick<
  SourceHealthObservation,
  "observationId" | "observedAt" | "status"
>): SourceHealthObservation {
  return {
    schema: 1,
    sourceKind: SOURCE_KIND_X_HOME_FYP,
    target: "home",
    ...partial,
  }
}

async function seedLayout() {
  const home = mkdtempSync(join(tmpdir(), "tc-pfx-crash-"))
  const agentRoot = join(home, "agent")
  const archiveRoot = join(home, "archive")
  mkdirSync(join(agentRoot, "state"), { recursive: true, mode: 0o700 })
  mkdirSync(join(home, "remediations", "artifacts"), { recursive: true, mode: 0o700 })
  const layout = remediationLayout(home)
  const store = createRemediationStore(layout)

  let ledger = emptySourceHealthLedger()
  for (const o of [
    observation({
      observationId: "sho_crash_healthy_prior___",
      observedAt: "2026-07-20T10:00:00.000Z",
      status: "healthy",
      postCount: 5,
      sourceCommit: "oldcommit111",
    }),
    observation({
      observationId: "sho_crash_unhealthy________",
      observedAt: "2026-07-20T12:00:00.000Z",
      status: "unhealthy",
      postCount: 0,
      hitCursor: false,
      reason: "empty-without-cursor",
    }),
  ]) {
    ledger = appendSourceHealthObservation(ledger, o)
  }
  await store.saveSourceHealthLedger(ledger)

  let index = emptyMarketClaimIndex()
  index = upsertMarketClaim(index, claimInWindow())
  await saveMarketClaimIndex(agentRoot, index)

  return { home, agentRoot, archiveRoot, layout, store }
}

function sessionVerdict(verdict: "stands" | "invalidated" | "inconclusive") {
  return async (args: Readonly<{ prompt: string; message: string }>) => {
    const claimId = /claimId=(\S+)/u.exec(args.message)?.[1] ?? CLAIM_ID
    const allowRaw = /allowlistedEvidence=([^\n]*)/u.exec(args.message)?.[1] ?? ""
    const allow = allowRaw.split(",").map((s) => s.trim()).filter(Boolean)
    const ref = allow.includes(CLAIM_REF) ? CLAIM_REF : (allow[0] ?? CLAIM_REF)
    return JSON.stringify({
      schema: 1,
      claimId,
      verdict,
      reason: `${verdict} by mock`,
      evidenceRefs: verdict === "inconclusive" ? [] : [ref],
      uncertainty: verdict === "inconclusive" ? ["unsure"] : [],
    })
  }
}

describe("post-fix claim audit crash / resume", () => {
  it("awaits recovery, then completes stands without correction, then already-corrected after invalidate path", async () => {
    const { home, agentRoot, archiveRoot, layout, store } = await seedLayout()
    const auditConfig = {
      enabled: true,
      requiredHealthyObservations: 2,
      maxRounds: 3,
      maxWaitHours: 24 * 365,
      autoCorrect: true,
    }

    const first = await runPostFixClaimAudit({
      layout,
      store,
      incident: baseIncident(),
      agentRoot,
      archiveRoot,
      config: auditConfig,
      sourceCommit: COMMIT,
      deployedAt: DEPLOYED_AT,
      home,
    })
    expect(first.phase).toBe("awaiting-recovery-data")
    expect(loadIntegrityHold(home)?.incidentId).toBe(INCIDENT_ID)

    let ledger = store.loadSourceHealthLedger()
    ledger = appendSourceHealthObservation(ledger, observation({
      observationId: "sho_crash_recover_a_______",
      observedAt: "2026-07-21T02:00:00.000Z",
      status: "healthy",
      postCount: 4,
      sourceCommit: COMMIT,
    }))
    ledger = appendSourceHealthObservation(ledger, observation({
      observationId: "sho_crash_recover_b_______",
      observedAt: "2026-07-21T03:00:00.000Z",
      status: "healthy",
      postCount: 3,
      sourceCommit: COMMIT,
    }))
    await store.saveSourceHealthLedger(ledger)

    const stands = await runPostFixClaimAudit({
      layout,
      store,
      incident: baseIncident(),
      agentRoot,
      archiveRoot,
      config: auditConfig,
      sourceCommit: COMMIT,
      deployedAt: DEPLOYED_AT,
      home,
      runSession: sessionVerdict("stands"),
    })
    expect(stands.phase).toBe("completed")
    expect(stands.detail).toBe("all-claims-stand")
    expect(stands.correctionEventIds).toBeUndefined()
    expect(loadIntegrityHold(home)).toBeUndefined()

    const invalidateHome = mkdtempSync(join(tmpdir(), "tc-pfx-crash-inv-"))
    const invAgent = join(invalidateHome, "agent")
    const invArchive = join(invalidateHome, "archive")
    mkdirSync(join(invAgent, "state"), { recursive: true, mode: 0o700 })
    mkdirSync(join(invalidateHome, "remediations", "artifacts"), { recursive: true, mode: 0o700 })
    const invLayout = remediationLayout(invalidateHome)
    const invStore = createRemediationStore(invLayout)
    await invStore.saveSourceHealthLedger(ledger)
    let index = emptyMarketClaimIndex()
    index = upsertMarketClaim(index, claimInWindow())
    await saveMarketClaimIndex(invAgent, index)

    const corrected = await runPostFixClaimAudit({
      layout: invLayout,
      store: invStore,
      incident: baseIncident({ incidentId: "rem-crashfix02" }),
      agentRoot: invAgent,
      archiveRoot: invArchive,
      config: auditConfig,
      sourceCommit: COMMIT,
      deployedAt: DEPLOYED_AT,
      home: invalidateHome,
      runSession: sessionVerdict("invalidated"),
    })
    expect(corrected.phase).toBe("completed")
    expect(corrected.detail).toBe("corrected")
    expect(corrected.correctionEventIds).toHaveLength(1)

    const outboxDir = join(invArchive, "router-outbox", `remediation-rem-crashfix02`)
    const files = readdirSync(outboxDir).filter((n) => n.endsWith(".json"))
    expect(files.length).toBeGreaterThanOrEqual(1)
    const staged = JSON.parse(readFileSync(join(outboxDir, files[0]!), "utf8")) as RouterEvent
    expect(staged.type).toBe("finding.correction")

    const replay = await runPostFixClaimAudit({
      layout: invLayout,
      store: invStore,
      incident: baseIncident({
        incidentId: "rem-crashfix02",
        correctionEventIds: corrected.correctionEventIds,
      }),
      agentRoot: invAgent,
      archiveRoot: invArchive,
      config: auditConfig,
      sourceCommit: COMMIT,
      deployedAt: DEPLOYED_AT,
      home: invalidateHome,
      runSession: sessionVerdict("invalidated"),
    })
    expect(replay.phase).toBe("completed")
    expect(replay.detail).toBe("already-corrected")
  })
})
