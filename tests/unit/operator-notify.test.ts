import { describe, expect, it } from "vitest"
import {
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
    expect(text).toContain("Still forming")
    expect(text).toContain("Treat documented RH token migrations")
    expect(text).toContain("rem-4b6d9126a855")
    expect(text).not.toMatch(/forming, queued-waiting/u)
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
})
