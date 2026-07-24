import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { ensureArchive } from "../../src/lib/archive.js"
import {
  beginEpochBuild,
  computeScorecard,
  planAuditEpoch,
  sealEpoch,
} from "../../src/orchestrator/scorecard.js"
import { openHarnessPullRequest } from "../../src/harness/pr.js"
import { runHarnessImprove } from "../../src/harness/schedule.js"
import { ConfigSchema } from "../../src/lib/config.js"
import { migrateConfigToV21 } from "../../src/migrations/config.js"

const CONFIG_HASH = `sha256:${"d".repeat(64)}` as const

async function seal(archiveRoot: string, epochId: string): Promise<void> {
  const layout = await ensureArchive(archiveRoot)
  const manifest = planAuditEpoch({
    epochId,
    previousEpochId: null,
    startedAt: 200_000,
    cutoffTimestamp: 109_000,
    settlementDelayHours: 6,
    priorSourceScoreCutoff: 90_000,
    configHash: CONFIG_HASH,
    featureSpecVersion: 1,
    executionModelVersion: 1,
    codeCommit: "abcdef1",
    subjects: [{
      id: "decision-1",
      type: "decision",
      eventTimestamp: 1_000,
      horizonHours: 24,
    }],
  })
  await beginEpochBuild(layout, manifest)
  const scorecard = computeScorecard({
    epochId,
    sealedAt: "2026-07-16T00:00:00.000Z",
    manifestHash: manifest.manifestHash,
    decisions: Array.from({ length: 10 }, (_, i) => ({
      verdict: "track",
      confidence: 60,
      hit: i < 7,
      excess72h: i < 7 ? 0.2 : 0.05,
    })),
    broadcasts: [],
    sourceCalls: [],
    outcomes: Array.from({ length: 10 }, () => ({ status: "complete" })),
    rugs: Array.from({ length: 10 }, () => ({ rug: false })),
    paperPnlGross: 10,
    paperPnlCostAdjusted: 8,
  })
  await sealEpoch(layout, epochId, scorecard, "2026-07-16T00:00:00.000Z")
}

function writeEnabledConfig(trenchcoatDir: string, scheduleEnabled = true): void {
  mkdirSync(trenchcoatDir, { recursive: true })
  const raw = migrateConfigToV21({
    schema: 4,
    telegram_channels: [],
    twitter: {
      operator_list_urls: ["https://x.com/i/lists/1", "https://x.com/i/lists/2"],
      scrape_home: true,
      max_pages_per_run: 5,
      managed_list: { name: "x", description: "y", capacity: 10 },
      source_lifecycle: {
        review_interval_hours: 24,
        max_transitions_per_review: 10,
        promotion: {
          min_eligible_calls: 10,
          min_distinct_tokens: 5,
          min_coverage: 0.8,
          min_hit_mean: 0.6,
          min_hit_lb95: 0.45,
          min_median_excess: 0.05,
          max_rug_exposure: 0.1,
          max_idle_days: 14,
        },
        demotion: {
          idle_days: 30,
          rug_exposure: 0.25,
          min_resolved_for_rug_drop: 4,
          coverage_floor: 0.5,
          score_floor: 0.4,
          consecutive_epochs: 2,
          readd_cooldown_days: 30,
          readd_min_new_calls: 5,
        },
      },
      engagement: { enabled: true, likes_per_window: 2, like_window_minutes: 10 },
    },
    research: {},
    broadcast: {},
    indicators: {},
    gate_thresholds: {},
    audit: { rsi_promotion: {} },
    wallets: { deterministic_weight: 0.8, llm_weight: 0.2, promotion: {}, drop: {} },
    source_safety: {},
    retention: {},
    chat: {},
    router: {},
    harness_improvement: {
      enabled: true,
      schedule_enabled: scheduleEnabled,
      require_two_epochs: false,
    },
  })
  const parsed = ConfigSchema.parse(raw)
  parsed.harness_improvement.enabled = true
  parsed.harness_improvement.schedule_enabled = scheduleEnabled
  parsed.harness_improvement.require_two_epochs = false
  writeFileSync(join(trenchcoatDir, "config.json"), `${JSON.stringify(parsed, null, 2)}\n`)
}

describe("harness PR helpers", () => {
  it("opens a PR via injected exec without merging", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-pr-"))
    mkdirSync(join(root, "agent"), { recursive: true })
    const calls: string[] = []
    const result = openHarnessPullRequest({
      worktreePath: root,
      branch: "harness/hyp-1",
      baseBranch: "main",
      title: "harness: hitRate",
      body: "test",
      push: true,
      createPr: true,
      exec: (bin, args) => {
        calls.push(`${bin} ${args.join(" ")}`)
        if (bin === "git" && args[0] === "status") {
          return { status: 0, stdout: " M agent/skills/x.md\n", stderr: "" }
        }
        if (bin === "git" && args[0] === "rev-parse") {
          return { status: 0, stdout: "abc123\n", stderr: "" }
        }
        if (bin === "gh" && args[0] === "pr" && args[1] === "create") {
          return { status: 0, stdout: "https://github.com/o/r/pull/9\n", stderr: "" }
        }
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    expect(result.prCreated).toBe(true)
    expect(result.prUrl).toContain("/pull/9")
    expect(calls.some((c) => c.startsWith("gh pr create"))).toBe(true)
    expect(calls.some((c) => c.includes("merge"))).toBe(false)
  })
})

describe("scheduled harness-improve", () => {
  it("skips when sealed epochs lack decision-time signals", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-sched-"))
    const archiveRoot = join(root, "archive")
    const home = join(root, "home")
    writeEnabledConfig(join(home, ".trenchcoat"), true)
    process.env["HOME"] = home

    await seal(archiveRoot, "audit-a")
    await seal(archiveRoot, "audit-b")

    const repoRoot = join(root, "repo")
    mkdirSync(repoRoot, { recursive: true })
    spawnSync("git", ["init", "-b", "main"], { cwd: repoRoot })
    writeFileSync(join(repoRoot, "package.json"), `${JSON.stringify({
      name: "trenchcoat",
      private: true,
    }, null, 2)}\n`)

    const report = await runHarnessImprove({
      archiveRoot,
      repoRoot,
      nowIso: "2026-07-16T12:00:00.000Z",
      developmentEpochId: "audit-a",
      holdoutEpochId: "audit-b",
      dryRun: true,
      runTests: false,
    })

    expect(report.status).toBe("skipped")
    expect(report.reason).toMatch(/decision-time signals/u)
  })

  it("skips when schedule_enabled is false", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-skip-"))
    const home = join(root, "home")
    writeEnabledConfig(join(home, ".trenchcoat"), false)
    process.env["HOME"] = home
    const report = await runHarnessImprove({
      archiveRoot: join(root, "archive"),
      repoRoot: process.cwd(),
      dryRun: true,
      runTests: false,
    })
    expect(report.status).toBe("skipped")
    expect(report.reason).toMatch(/schedule_enabled/u)
  })
})
