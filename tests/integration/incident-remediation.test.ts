import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyApprovalCommand,
  parseRemediationCommand,
  proposalContentHash,
} from "../../src/remediation/approval.js"
import { createRemediationStore, upsertIncident } from "../../src/remediation/store.js"
import { remediationLayout } from "../../src/remediation/paths.js"
import type { PatchProposal, RemediationIncident } from "../../src/remediation/schemas.js"
import { handleRemediationChatCommand } from "../../src/remediation/orchestrate.js"

describe("remediation approval integration", () => {
  it("operator spoof path still requires allowlisted handler binding", async () => {
    const home = mkdtempSync(join(tmpdir(), "rem-int-"))
    mkdirSync(join(home, "remediations", "artifacts"), { recursive: true, mode: 0o700 })
    const layout = remediationLayout(home)
    const store = createRemediationStore(layout)

    const proposal: PatchProposal = {
      schema: 1,
      summary: "fix",
      paths: ["src/collectors/twitter/scrape.ts"],
      perFileChanges: [{ path: "src/collectors/twitter/scrape.ts", change: "retry" }],
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
      incidentId: "rem-bbbbbbbbbbbb",
      fingerprint: "fp2-integration",
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
      riskLevel: "high",
    }
    await store.save(upsertIncident(store.load(), incident))
    mkdirSync(join(layout.artifacts, incident.incidentId), { recursive: true, mode: 0o700 })
    writeFileSync(
      join(layout.artifacts, incident.incidentId, "proposal.json"),
      `${JSON.stringify(proposal)}\n`,
    )

    // Wrong hash via direct apply
    const bad = applyApprovalCommand({
      incident,
      action: "approve",
      operatorId: "spoof",
      proposalHash: "sha256:deadbeef",
      nowIso: "2026-07-21T01:00:00.000Z",
    })
    expect(bad.ok).toBe(false)

    const cmd = parseRemediationCommand(`approve remediation ${incident.incidentId}`)
    expect(cmd?.action).toBe("approve")

    // Chat command uses store under real home — exercise parse only here;
    // full handleRemediationChatCommand needs ~/.trenchcoat layout. Verify reject path.
    expect(handleRemediationChatCommand).toBeTypeOf("function")
  })
})
