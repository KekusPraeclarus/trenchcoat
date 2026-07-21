import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
  classifyRemediationRisk,
  isAbsoluteDenyPath,
  isLowRiskPath,
} from "../../src/remediation/risk.js"
import { evaluateProposedPaths } from "../../src/remediation/confinement.js"
import {
  applyApprovalCommand,
  proposalContentHash,
} from "../../src/remediation/approval.js"
import type { PatchProposal, RemediationIncident } from "../../src/remediation/schemas.js"

describe("prop_inv_s27_path_escape", () => {
  it("arbitrary traversal/absolute paths never evaluate ok", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 64 }),
      (suffix) => {
        const paths = [
          `../${suffix}`,
          `/${suffix}`,
          `src/remediation/${suffix}`,
          `.env.${suffix}`,
        ]
        for (const path of paths) {
          if (path.includes("\0")) continue
          const r = evaluateProposedPaths({ paths: [path] })
          expect(r.ok).toBe(false)
        }
      },
    ), { numRuns: 40 })
  })
})

describe("prop_inv_s27_risk_never_downgrades_sensitive", () => {
  it("sensitive paths never classify as low", () => {
    const sensitive = [
      "src/lib/config.ts",
      "src/chat/handler.ts",
      "src/harness/schedule.ts",
      "src/orchestrator/integrity.ts",
      "ops/install-launchd.sh",
      "package.json",
    ]
    for (const path of sensitive) {
      expect(isLowRiskPath(path)).toBe(false)
      expect(classifyRemediationRisk({ paths: [path] }).level).not.toBe("low")
    }
    expect(isAbsoluteDenyPath("src/remediation/agents.ts")).toBe(true)
  })
})

describe("prop_inv_s27_approval_hash_bound", () => {
  it("approvals cannot cross proposal hashes", () => {
    fc.assert(fc.property(
      fc.string({ minLength: 4, maxLength: 40 }),
      fc.string({ minLength: 4, maxLength: 40 }),
      (a, b) => {
        const proposalA: PatchProposal = {
          schema: 1,
          summary: a,
          paths: ["src/collectors/twitter/scrape.ts"],
          perFileChanges: [{ path: "src/collectors/twitter/scrape.ts", change: a }],
          tests: ["t"],
          invariants: [],
          docs: [],
          rollout: "r",
          smokeChecks: ["smoke:default"],
          rollback: "rb",
        }
        const proposalB: PatchProposal = { ...proposalA, summary: b, perFileChanges: [{ path: "src/collectors/twitter/scrape.ts", change: b }] }
        const hashA = proposalContentHash(proposalA)
        const hashB = proposalContentHash(proposalB)
        if (hashA === hashB) return
        const incident: RemediationIncident = {
          schema: 1,
          incidentId: "rem-aaaaaaaaaaaa",
          fingerprint: "fp",
          phase: "awaiting-approval",
          createdAt: "2026-07-21T00:00:00.000Z",
          updatedAt: "2026-07-21T00:00:00.000Z",
          title: "t",
          severity: "warn",
          proposalHash: hashA,
          approvalExpiresAt: "2099-01-01T00:00:00.000Z",
          attemptCount: 0,
          originMoveRebuilds: 0,
          evidencePaths: [],
        }
        const cross = applyApprovalCommand({
          incident,
          action: "approve",
          operatorId: "1",
          proposalHash: hashB,
          nowIso: "2026-07-21T01:00:00.000Z",
        })
        expect(cross.ok).toBe(false)
      },
    ), { numRuns: 30 })
  })
})
