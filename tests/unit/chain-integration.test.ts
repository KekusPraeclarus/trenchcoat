import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { extractDiscordResearchIntent } from "../../src/discord/intent.js"
import {
  evaluateBuildConfinement,
  evaluateFinalizeConfinement,
} from "../../src/chain-integration/confinement.js"
import {
  validateFinalReview,
  validateResearchProposal,
} from "../../src/chain-integration/agents.js"
import type { ChainResearchProposal } from "../../src/chain-integration/schemas.js"
import { ChainManifestSchema } from "../../src/lib/chain-manifest.js"

describe("discord unknown-chain intent", () => {
  it("accepts exact unknown slug:address", () => {
    const intent = extractDiscordResearchIntent(
      "plasmafake:0x6100E367285b01F48D07953803A2d8dCA5D19873",
    )
    expect(intent.kind).toBe("chain-integration")
    if (intent.kind === "chain-integration") {
      expect(intent.slug).toBe("plasmafake")
      expect(intent.tokenAddress.toLowerCase()).toBe(
        "0x6100e367285b01f48d07953803a2d8dca5d19873",
      )
    }
  })

  it("accepts research-verb prefix", () => {
    const intent = extractDiscordResearchIntent(
      "research foobarbaz:0x6100E367285b01F48D07953803A2d8dCA5D19873",
    )
    expect(intent.kind).toBe("chain-integration")
  })

  it("does not treat chatter as chain-integration", () => {
    const intent = extractDiscordResearchIntent(
      "please research foobarbaz:0x6100E367285b01F48D07953803A2d8dCA5D19873 thanks",
    )
    expect(intent.kind).not.toBe("chain-integration")
  })

  it("rejects traversal-like slugs", () => {
    const intent = extractDiscordResearchIntent(
      "../etc:0x6100E367285b01F48D07953803A2d8dCA5D19873",
    )
    expect(intent.kind).toBe("ignore")
  })

  it("routes known chains to research", () => {
    const intent = extractDiscordResearchIntent(
      "solana:So11111111111111111111111111111111111111112",
    )
    expect(intent.kind).toBe("research")
  })
})

describe("chain integration confinement", () => {
  it("rejects forbidden path edits", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-confine-"))
    mkdirSync(join(dir, "chains"), { recursive: true })
    mkdirSync(join(dir, "src", "harness"), { recursive: true })
    writeFileSync(join(dir, "src", "harness", "schedule.ts"), "x\n")
    // Initialize git so listChanged works
    spawnSync("git", ["init"], { cwd: dir })
    spawnSync("git", ["add", "-A"], { cwd: dir })
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "i"], {
      cwd: dir,
    })
    writeFileSync(join(dir, "src", "harness", "schedule.ts"), "y\n")
    const manifest = ChainManifestSchema.parse({
      schema: 1,
      slug: "newchain",
      display: "New",
      family: "evm",
      aliases: [],
      geckoterminalNetwork: "newchain",
      dexscreenerChainId: "newchain",
      nativeBenchmark: "ethereum:eth",
      addressFormat: "evm",
      walletTracking: "unsupported",
      capabilities: {
        research: true,
        discordWatch: true,
        mainTrack: false,
        geckoBars: true,
        narrativeDiscovery: false,
        walletTracking: false,
      },
    })
    const result = evaluateBuildConfinement({
      worktreePath: dir,
      slug: "newchain",
      baselineManifestSlugs: [],
      validatedManifest: manifest,
    })
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.includes("forbidden"))).toBe(true)
  })

  it("finalize allowlist rejects ops edits", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-fin-"))
    mkdirSync(join(dir, "ops"), { recursive: true })
    spawnSync("git", ["init"], { cwd: dir })
    writeFileSync(join(dir, "ops", "install-launchd.sh"), "old\n")
    spawnSync("git", ["add", "-A"], { cwd: dir })
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "i"], {
      cwd: dir,
    })
    writeFileSync(join(dir, "ops", "install-launchd.sh"), "new\n")
    const result = evaluateFinalizeConfinement({
      worktreePath: dir,
      slug: "newchain",
      afterBuildChanged: [],
    })
    expect(result.ok).toBe(false)
  })
})

describe("research proposal validation", () => {
  const baseManifest = {
    schema: 1 as const,
    slug: "newchain",
    display: "New",
    family: "evm" as const,
    aliases: [] as string[],
    geckoterminalNetwork: "newchain",
    dexscreenerChainId: "newchain",
    nativeBenchmark: "ethereum:eth",
    addressFormat: "evm" as const,
    walletTracking: "unsupported" as const,
    quoteAssets: { acceptNative: true, allowlist: [] as string[] },
    capabilities: {
      research: true,
      discordWatch: true,
      mainTrack: false,
      geckoBars: true,
      narrativeDiscovery: false,
      walletTracking: false,
    },
  }

  it("rejects non-empty uncertainty", () => {
    const proposal: ChainResearchProposal = {
      schema: 1,
      manifest: baseManifest,
      requestedToken: "0x6100E367285b01F48D07953803A2d8dCA5D19873",
      confidence: 80,
      uncertainty: ["maybe"],
      evidencePaths: [],
    }
    const result = validateResearchProposal({
      proposal,
      expectedSlug: "newchain",
      tokenAddress: "0x6100E367285b01F48D07953803A2d8dCA5D19873",
      dexOk: true,
      geckoOk: true,
      goplusSupported: false,
    })
    expect(result.ok).toBe(false)
  })

  it("rejects wallet tracking enablement", () => {
    const proposal: ChainResearchProposal = {
      schema: 1,
      manifest: {
        ...baseManifest,
        walletTracking: "infura",
        capabilities: { ...baseManifest.capabilities, walletTracking: true },
      },
      requestedToken: "0x6100E367285b01F48D07953803A2d8dCA5D19873",
      confidence: 90,
      uncertainty: [],
      evidencePaths: [],
    }
    const result = validateResearchProposal({
      proposal,
      expectedSlug: "newchain",
      tokenAddress: "0x6100E367285b01F48D07953803A2d8dCA5D19873",
      dexOk: true,
      geckoOk: true,
      goplusSupported: false,
    })
    expect(result.ok).toBe(false)
  })

  it("allows research-only without scanner", () => {
    const proposal: ChainResearchProposal = {
      schema: 1,
      manifest: baseManifest,
      requestedToken: "0x6100E367285b01F48D07953803A2d8dCA5D19873",
      confidence: 90,
      uncertainty: [],
      evidencePaths: [],
    }
    const result = validateResearchProposal({
      proposal,
      expectedSlug: "newchain",
      tokenAddress: "0x6100E367285b01F48D07953803A2d8dCA5D19873",
      dexOk: true,
      geckoOk: true,
      goplusSupported: false,
    })
    expect(result.ok).toBe(true)
  })

  it("final review rejects uncertainty", () => {
    const result = validateFinalReview({
      schema: 1,
      verdict: "approve",
      findings: {
        evidenceSufficient: true,
        testCoverageAdequate: true,
        securitySurfaceOk: true,
        rollbackAdequate: true,
        docsUpdated: true,
        uncertainty: ["hmm"],
      },
    })
    expect(result.ok).toBe(false)
  })
})
