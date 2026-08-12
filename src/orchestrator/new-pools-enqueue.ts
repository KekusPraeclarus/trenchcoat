import { existsSync, readFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { enqueueResearch } from "../lib/research-queue.js"
import {
  runArchiveDir,
  writeJsonRecordFsync,
  type ArchiveLayout,
} from "../lib/archive.js"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { sha256Json } from "../lib/canonical-json.js"
import {
  NewPoolsEnqueueReceiptSchema,
  type NewPoolsEnqueueReceipt,
  type NewPoolsFeedItem,
  type ResearchQueueEntry,
} from "../contracts/schemas.js"
import { appendDiscoveryLog } from "./discovery-log.js"

function enqueueCountPath(archiveRoot: string, day: string): string {
  return join(archiveRoot, "provider-usage", "new-pools", `enqueues-${day}.json`)
}

export async function newPoolsDailyCount(
  archiveRoot: string,
  day: string,
): Promise<number> {
  const path = enqueueCountPath(archiveRoot, day)
  if (!existsSync(path)) return 0
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { count?: number }
    return Number(raw.count ?? 0)
  } catch {
    return 0
  }
}

async function saveDailyCount(
  archiveRoot: string,
  day: string,
  count: number,
): Promise<void> {
  const path = enqueueCountPath(archiveRoot, day)
  mkdirSync(join(archiveRoot, "provider-usage", "new-pools"), {
    recursive: true,
    mode: 0o700,
  })
  await writeAtomicFile(
    path,
    `${JSON.stringify({ schema: 1, day, count }, null, 2)}\n`,
  )
}

function expiryIso(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) + days * 86_400_000).toISOString()
}

function queueIdFor(item: NewPoolsFeedItem, runId: string): string {
  const digest = sha256Json({
    kind: "new-pools-enqueue",
    chain: item.chain,
    token: item.tokenAddress,
    runId,
  }).replace(/^sha256:/u, "")
  return `rq-new-pools-${digest.slice(0, 24)}`
}

function reasonFor(item: NewPoolsFeedItem): string {
  if (item.marketQualityStatus === "pass") {
    return "new-pools security-pass mq-pass"
  }
  const mq = item.marketQualityReasons.length > 0
    ? item.marketQualityReasons.join(",")
    : "unknown"
  return `new-pools security-pass mq-fail:${mq}`.slice(0, 280)
}

function discoveryRecordId(parts: Readonly<Record<string, string>>): string {
  const digest = sha256Json({
    kind: "discovery-new-pools-enqueue",
    ...parts,
  } as never).replace(/^sha256:/u, "")
  return `dl-npe-${digest.slice(0, 40)}`
}

export type NewPoolsEnqueueResult = Readonly<{
  accepted: number
  rejected: number
  shadowMode: boolean
  receipt: NewPoolsEnqueueReceipt
}>

export async function enqueueNewPoolsResearch(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  runId: string
  nowIso: string
  survivors: readonly NewPoolsFeedItem[]
  dryRun?: boolean
}>): Promise<NewPoolsEnqueueResult> {
  const config = loadConfig()
  const feed = config.new_pools_feed
  const shadowMode = feed.shadow_mode
  const day = args.nowIso.slice(0, 10)
  let usedToday = await newPoolsDailyCount(args.layout.root, day)
  const maxRun = feed.max_enqueues_per_run
  const maxDay = feed.max_enqueues_per_day

  const accepted: NewPoolsEnqueueReceipt["accepted"] = []
  const rejected: NewPoolsEnqueueReceipt["rejected"] = []
  const state = new StateStore(join(args.agentRoot, "state"))
  let queue = state.loadResearchQueue()
  let runAccepted = 0

  for (const item of args.survivors) {
    if (runAccepted >= maxRun) {
      rejected.push({
        chain: item.chain,
        tokenAddress: item.tokenAddress,
        reason: "run-cap",
      })
      continue
    }
    if (usedToday >= maxDay) {
      rejected.push({
        chain: item.chain,
        tokenAddress: item.tokenAddress,
        reason: "daily-cap",
      })
      continue
    }
    if (item.securityStatus !== "pass") {
      rejected.push({
        chain: item.chain,
        tokenAddress: item.tokenAddress,
        reason: "security-not-pass",
      })
      continue
    }

    const entry: ResearchQueueEntry = {
      schema: 1,
      queueId: queueIdFor(item, args.runId),
      subject: `${item.chain}:${item.tokenAddress}`,
      chain: item.chain,
      tokenAddress: item.tokenAddress,
      pairAddress: item.pairAddress,
      ...(item.symbolDisplay ? { symbolDisplay: item.symbolDisplay } : {}),
      resolution: "resolved",
      priority: 40,
      firstSeen: args.nowIso,
      enqueuedAt: args.nowIso,
      enqueuedBy: `new-pools:${args.runId}`,
      trigger: "new-pools",
      expiresAt: expiryIso(args.nowIso, config.research.queue_expiry_days),
      provenance: [item.provenance].slice(0, 32),
      clusterCount: 1,
      security: {
        status: "pass",
        flags: [...item.securityFlags].slice(0, 32),
      },
      status: "pending",
      reason: reasonFor(item),
    }

    if (!shadowMode && !args.dryRun) {
      queue = enqueueResearch(queue, entry, config.research.daily_cap)
    }

    accepted.push({
      queueId: entry.queueId,
      chain: item.chain,
      tokenAddress: item.tokenAddress,
      marketQualityStatus: item.marketQualityStatus,
    })
    runAccepted += 1
    usedToday += 1

    await appendDiscoveryLog(args.layout, {
      schema: 1,
      recordId: discoveryRecordId({
        runId: args.runId,
        chain: item.chain,
        token: item.tokenAddress,
        reason: "enqueued",
      }),
      recordedAt: args.nowIso,
      runId: args.runId,
      trigger: "new-pools",
      chain: item.chain,
      tokenAddress: item.tokenAddress,
      pairAddress: item.pairAddress,
      subject: entry.subject,
      reason: "enqueued",
      source: "enqueue",
      securityStatus: "pass",
      ...(item.marketQualityReasons.length > 0
        ? { marketQualityReasons: [...item.marketQualityReasons] }
        : {}),
      surfacedAt: args.nowIso,
    })
  }

  if (!shadowMode && !args.dryRun && runAccepted > 0) {
    await state.saveResearchQueue(queue)
    await saveDailyCount(args.layout.root, day, usedToday)
  }

  const receipt = NewPoolsEnqueueReceiptSchema.parse({
    schema: 1,
    runId: args.runId,
    enqueuedAt: args.nowIso,
    accepted,
    rejected,
  })

  const archivePath = join(
    runArchiveDir(args.layout, args.runId),
    "new-pools-enqueue-receipt.json",
  )
  mkdirSync(runArchiveDir(args.layout, args.runId), {
    recursive: true,
    mode: 0o700,
  })
  await writeJsonRecordFsync(archivePath, receipt as never)

  const reportDir = join(args.agentRoot, "reports", args.runId)
  mkdirSync(reportDir, { recursive: true, mode: 0o700 })
  await writeAtomicFile(
    join(reportDir, "new-pools-enqueue-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  )

  return {
    accepted: accepted.length,
    rejected: rejected.length,
    shadowMode,
    receipt,
  }
}
