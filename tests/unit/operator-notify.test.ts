import { describe, expect, it } from "vitest"
import {
  renderRemediationApprovalHost,
  renderRemediationFailureHost,
  renderSuggestionDigestHost,
} from "../../src/remediation/operator-notify.js"
import type { RemediationIncident, SuggestionLedgerEntry } from "../../src/remediation/schemas.js"

function entry(
  partial: Partial<SuggestionLedgerEntry> & Pick<SuggestionLedgerEntry, "entryId" | "outcome">,
): SuggestionLedgerEntry {
  return {
    schema: 1,
    threadId: "th-test",
    channelId: "1111111111111111111",
    contentFingerprint: "abcdefghijklmnop",
    humanMessageIds: ["1000000000000000001"],
    allMessageIds: ["1000000000000000001"],
    participantIds: ["2222222222222222222"],
    formingRounds: 0,
    createdAt: "2026-07-22T21:08:23.068Z",
    updatedAt: "2026-07-22T21:08:23.068Z",
    lastActivityAt: "2026-07-22T21:08:23.068Z",
    ...partial,
  }
}

describe("operator-notify", () => {
  it("renders suggestion digests with labels and summaries", () => {
    const text = renderSuggestionDigestHost({
      day: "2026-07-22",
      entries: [
        entry({
          entryId: "sug-queued123",
          outcome: "queued",
          category: "bug-fix",
          summary: "Treat documented RH token migrations as structured paths",
          incidentId: "rem-4b6d9126a855",
        }),
        entry({
          entryId: "sug-waiting12",
          outcome: "queued-waiting",
          category: "small-feature",
          summary: "Suppress low-signal tracked-token delta pings",
          reason: "suggestion-capacity",
        }),
        entry({
          entryId: "sug-forming12",
          outcome: "forming",
          formingNote: "KARMA vs WALLET comparison still needs a clearer spec",
        }),
      ],
    })
    expect(text).toContain("Discord suggestions 2026-07-22")
    expect(text).toContain("Queued for build")
    expect(text).toContain("Waiting (capacity")
    expect(text).toContain("Treat documented RH token migrations")
    expect(text).toContain("rem-4b6d9126a855")
    expect(text).not.toMatch(/forming, queued-waiting/u)
    // Forming entries collapse into one count and lose their notes
    expect(text).toContain("Forming: 1 thread(s) still incomplete")
    expect(text).not.toContain("KARMA vs WALLET comparison")
  })

  it("explains propose session failures with title and stage", () => {
    const incident: RemediationIncident = {
      schema: 1,
      incidentId: "rem-4b6d9126a855",
      fingerprint: "fp-test-suggestion-01",
      phase: "failed",
      createdAt: "2026-07-22T21:08:23.068Z",
      updatedAt: "2026-07-23T03:54:39.866Z",
      title: "When comparing Robinhood tokens, treat documented v1→v2 migrations",
      severity: "warn",
      attemptCount: 0,
      originMoveRebuilds: 0,
      preReviewReviseCount: 0,
      evidencePaths: [],
      origin: "discord-suggestion",
    }
    const text = renderRemediationFailureHost({
      incident,
      detail: "propose:session failed",
    })
    expect(text).toContain("Remediation failed rem-4b6d9126a855")
    expect(text).toContain("When comparing Robinhood tokens")
    expect(text).toContain("Propose")
    expect(text).toMatch(/no usable output|session failed/iu)
    expect(text).toContain("not rejected")
  })

  it("renders approval cards with plain-language sections and exact commands", () => {
    const incident: RemediationIncident = {
      schema: 1,
      incidentId: "rem-92da03a5713e",
      fingerprint: "fp-test-approval-01",
      phase: "awaiting-approval",
      createdAt: "2026-07-22T21:08:23.068Z",
      updatedAt: "2026-07-23T13:01:17.149Z",
      title: "RAIL vs VEIL comparison failed due to research lock conflicts",
      severity: "info",
      attemptCount: 0,
      originMoveRebuilds: 0,
      preReviewReviseCount: 0,
      evidencePaths: [],
      origin: "discord-suggestion",
      riskLevel: "high",
      proposalHash: "sha256:test",
      approvalExpiresAt: "2026-07-24T13:01:17.148Z",
    }
    const text = renderRemediationApprovalHost({
      incident,
      diagnosisSummary: "Discord report-copy lost the agent workspace lock race.",
      proposalSummary: "Hold the lock longer and re-kick synthesis when research finishes.",
      paths: ["src/discord/conversation.ts", "docs/architecture/discord-conversation.md"],
      tests: ["unit: discord conversation lock"],
      invariants: ["INV-S15"],
      rollout: "monitor comparison threads",
      rollback: "revert conversation hooks",
    })
    expect(text).toContain("Needs your approval")
    expect(text).toContain("What happened:")
    expect(text).toContain("Proposed fix:")
    expect(text).toContain("approve remediation rem-92da03a5713e")
    expect(text).toContain("keep the hyphen")
  })
})
