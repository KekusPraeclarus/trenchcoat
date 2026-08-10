import { mkdtempSync, cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  agentLockPath,
  jobRequiresAgentWorkspaceLock,
  WorkspaceLock,
} from "../../src/lib/lock.js"
import { runJob } from "../../src/orchestrator/run.js"
import { ConfigSchema } from "../../src/lib/config.js"
import { migrateConfigToV25 } from "../../src/migrations/config.js"
import { runArchiveDir, ensureArchive } from "../../src/lib/archive.js"

describe("run loop locking", () => {
  it("refuses a concurrent workspace writer with exit code 3", async () => {
    const root = mkdtempSync(join(tmpdir(), "trenchcoat-agent-"))
    const agentRoot = join(root, "agent")
    cpSync(join(process.cwd(), "agent"), agentRoot, { recursive: true })
    mkdirSync(join(root, "archive"), { recursive: true })
    const lock = new WorkspaceLock(agentLockPath(agentRoot))
    expect(lock.tryAcquire()).toBe(true)

    try {
      await expect(runJob({
        job: "review",
        paths: { agentRoot, archiveRoot: join(root, "archive") },
        skipAgent: true,
        dryCollect: true,
      })).resolves.toMatchObject({ exitCode: 3 })
    } finally {
      lock.release()
    }
  })

  it("lets improvement jobs run while the agent workspace lock is held", async () => {
    expect(jobRequiresAgentWorkspaceLock("incident-remediate")).toBe(false)
    expect(jobRequiresAgentWorkspaceLock("harness-improve")).toBe(false)
    expect(jobRequiresAgentWorkspaceLock("harness-meta-improve")).toBe(false)
    expect(jobRequiresAgentWorkspaceLock("list-scan")).toBe(true)

    const root = mkdtempSync(join(tmpdir(), "trenchcoat-improve-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    const home = join(root, "home")
    const trench = join(home, ".trenchcoat")
    mkdirSync(trench, { recursive: true })
    const raw = migrateConfigToV25({
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
        schedule_enabled: true,
        require_two_epochs: true,
      },
    })
    const parsed = ConfigSchema.parse(raw)
    parsed.harness_improvement.enabled = true
    parsed.harness_improvement.schedule_enabled = true
    parsed.harness_improvement.require_two_epochs = true
    writeFileSync(join(trench, "config.json"), `${JSON.stringify(parsed, null, 2)}\n`)
    process.env["HOME"] = home

    const repoRoot = join(root, "repo")
    mkdirSync(join(repoRoot, ".git"), { recursive: true })
    writeFileSync(join(repoRoot, "package.json"), "{}\n")
    process.env["TRENCHCOAT_REPO_ROOT"] = repoRoot

    cpSync(join(process.cwd(), "agent"), agentRoot, { recursive: true })
    mkdirSync(archiveRoot, { recursive: true })
    const layout = await ensureArchive(archiveRoot)
    const lock = new WorkspaceLock(agentLockPath(agentRoot))
    expect(lock.tryAcquire()).toBe(true)

    try {
      const result = await runJob({
        job: "harness-improve",
        paths: { agentRoot, archiveRoot },
        skipAgent: true,
        dryCollect: true,
      })
      expect(result.exitCode).toBe(0)

      const runDirs = readdirSync(layout.runs).filter((n) => n.startsWith("harness-improve-"))
      expect(runDirs.length).toBeGreaterThanOrEqual(1)
      const runId = runDirs.sort().at(-1)!
      const hostReport = JSON.parse(readFileSync(
        join(runArchiveDir(layout, runId), "host-reports", "harness-improve.json"),
        "utf8",
      )) as { status?: string, reasonSlug?: string }
      expect(hostReport.status).toBe("skipped")
      expect(hostReport.reasonSlug).toBeTruthy()

      expect(existsSync(join(root, "harness-improvements", "schedule-report.json"))).toBe(true)
      const skipLedger = join(archiveRoot, "skips", "harness-improve.jsonl")
      expect(existsSync(skipLedger)).toBe(true)
      const skipLine = readFileSync(skipLedger, "utf8").trim().split("\n").at(-1)!
      expect(JSON.parse(skipLine).reason).toBeTruthy()
    } finally {
      lock.release()
    }
  }, 60_000)
})
