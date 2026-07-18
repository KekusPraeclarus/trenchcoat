import { describe, expect, it } from "vitest"
import { processFarcasterScanEngagement } from "../../src/orchestrator/fc-engagement.js"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const live = process.env["TRENCHCOAT_LIVE_E2E"] === "1"

describe.runIf(live)("farcaster live gates", () => {
  it("probe reports signer status and feed assessment", async () => {
    const { loadConfig, loadEnvSecrets } = await import("../../src/lib/config.js")
    const { scrapeConfiguredFarcaster } = await import("../../src/collectors/farcaster/scrape.js")
    const { probeFarcasterSigner } = await import("../../src/collectors/farcaster/signer.js")
    const cfg = loadConfig()
    const secrets = loadEnvSecrets()
    expect(secrets.neynarApiKey, "NEYNAR_API_KEY required").toBeTruthy()
    expect(cfg.farcaster.bot_fid, "farcaster.bot_fid required").toBeTypeOf("number")

    const probe = await probeFarcasterSigner({ apiKey: secrets.neynarApiKey! })
    expect(["approved", "pending", "rejected", "unavailable"]).toContain(probe.status)

    const bundles = await scrapeConfiguredFarcaster(cfg, { apiKey: secrets.neynarApiKey! })
    expect(bundles.length).toBeGreaterThan(0)
    for (const bundle of bundles) {
      expect(bundle.assessment.counts.total).toBeGreaterThanOrEqual(0)
      for (const cast of bundle.assessment.eligibleCasts) {
        expect(bundle.assessment.counts.expired).toBeGreaterThanOrEqual(0)
        const ageHours = (Date.now() - Date.parse(cast.timestamp)) / 3_600_000
        expect(ageHours).toBeLessThanOrEqual(24)
      }
    }
  }, 60_000)

  it("blocks engagement mutations when signer is not approved", async () => {
    const { loadEnvSecrets } = await import("../../src/lib/config.js")
    const { probeFarcasterSigner } = await import("../../src/collectors/farcaster/signer.js")
    const secrets = loadEnvSecrets()
    const probe = await probeFarcasterSigner({ apiKey: secrets.neynarApiKey! })
    if (probe.status === "approved") return

    const root = mkdtempSync(join(tmpdir(), "tc-fc-live-gate-"))
    const agentRoot = join(root, "agent")
    const runId = "fc-live-gate"
    const reportDir = join(agentRoot, "reports", runId)
    mkdirSync(reportDir, { recursive: true })
    writeFileSync(join(reportDir, "fc-engagement.json"), `${JSON.stringify({
      schema: 1,
      runId,
      proposedAt: new Date().toISOString(),
      items: [{
        action: "like",
        castHash: "0x1111111111111111111111111111111111111111",
        authorHandle: "alice",
        reasonCode: "narrative_signal",
        topics: [],
        rationale: "probe",
      }],
    }, null, 2)}\n`)

    const report = await processFarcasterScanEngagement({
      agentRoot,
      archiveRoot: join(root, "archive"),
      runId,
      execute: true,
      fypCasts: [{ hash: "0x1111111111111111111111111111111111111111", author: "alice" }],
    })
    expect(report.executed).toBe(0)
    expect(report.signerGate?.mutationsAllowed).toBe(false)
  }, 60_000)
})

describe.runIf(!live)("farcaster live placeholder", () => {
  it("skips when TRENCHCOAT_LIVE_E2E is not set", () => {
    expect(live).toBe(false)
  })
})
