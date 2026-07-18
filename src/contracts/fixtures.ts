/**
 * Shared golden fixtures for Wave 1 module tests.
 * Not production data — deterministic shapes for offline verification.
 */

export const GOLDEN_RUN_ID = "20260717T120000Z-ab12cd34"

export const GOLDEN_PROVENANCE = "x:list:managed:tweet:1234567890"

export const GOLDEN_INBOX_MANIFEST = Object.freeze({
  "twitter-list.json": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "market-security.json": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
}) as Readonly<Record<string, `sha256:${string}`>>

export const GOLDEN_POLICY = Object.freeze({
  schema: 1 as const,
  policyVersion: "baseline-v1",
  kind: "baseline" as const,
  createdAt: "2026-07-17T12:00:00.000Z",
  weights: { confidence: 1, clusters: 0.5 },
  thresholds: { trackConfidence: 60 },
  rules: [],
  allowlistPaths: ["agent/skills/harness-experiment/"],
})

export const GOLDEN_ALPHA_DIGEST = Object.freeze({
  schema: 1 as const,
  runId: GOLDEN_RUN_ID,
  proposedAt: "2026-07-17T12:05:00.000Z",
  entries: [
    {
      provenance: "tg:alpha:msg:1",
      channel: "alpha",
      messageId: "msg-1",
      contentHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as `sha256:${string}`,
      records: [
        {
          path: "state/research/example.md",
          contentHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as `sha256:${string}`,
        },
      ],
    },
  ],
})
