import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendRemediationJournal,
  createRemediationStore,
  upsertIncident,
} from "../../src/remediation/store.js"
import { remediationLayout } from "../../src/remediation/paths.js"
import {
  applyApprovalCommand,
  proposalContentHash,
} from "../../src/remediation/approval.js"
import type { PatchProposal, RemediationIncident } from "../../src/remediation/schemas.js"

describe("remediation crash resume idempotency", () => {
  it("duplicate journal appends and approval are single-use", async () => {
    const home = mkdtempSync(join(tmpdir(), "rem-crash-"))
    mkdirSync(join(home, "remediations"), { recursive: true, mode: 0o700 })
    const layout = remediationLayout(home)
    const store = createRemediationStore(layout)

    const proposal: PatchProposal = {
      schema: 1,
      summary: "s",
      paths: ["src/collectors/twitter/scrape.ts"],
      perFileChanges: [{ path: "src/collectors/twitter/scrape.ts", change: "c" }],
      tests: ["t"],
      invariants: [],
      docs: [],
      rollout: "r",
      smokeChecks: ["smoke:default"],
      rollback: "rb",
    }
    const hash = proposalContentHash(proposal)
    const incident: RemediationIncident = {
      schema: 1,
      incidentId: "rem-cccccccccccccccc",
      fingerprint: "fp-crash-01",
      phase: "awaiting-approval",
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
      title: "t",
      severity: "warn",
      proposalHash: hash,
      approvalExpiresAt: "2099-01-01T00:00:00.000Z",
      attemptCount: 0,
      originMoveRebuilds: 0,
      evidencePaths: [],
    }
    await store.save(upsertIncident(store.load(), incident))
    await appendRemediationJournal(layout, incident.incidentId, { event: "phase", phase: "awaiting-approval" })
    await appendRemediationJournal(layout, incident.incidentId, { event: "phase", phase: "awaiting-approval" })

    const first = applyApprovalCommand({
      incident,
      action: "approve",
      operatorId: "1",
      proposalHash: hash,
      nowIso: "2026-07-21T01:00:00.000Z",
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    await store.save(upsertIncident(store.load(), first.incident))

    const second = applyApprovalCommand({
      incident: first.incident,
      action: "approve",
      operatorId: "1",
      proposalHash: hash,
      nowIso: "2026-07-21T01:01:00.000Z",
    })
    expect(second.ok).toBe(false)
    expect(store.findById(incident.incidentId)?.phase).toBe("approved")
  })
})
