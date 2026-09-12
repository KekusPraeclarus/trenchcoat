#!/usr/bin/env node
// Operator catch-up for X likes blocked by bot health. Host-only.
// State: ~/.trenchcoat/x-like-backfill.json  Log: ~/.trenchcoat/x-like-backfill.jsonl

import { randomInt } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const HOME = join(homedir(), ".trenchcoat")
const RUNTIME = join(HOME, "runtime", "dist")
const STATE_PATH = join(HOME, "x-like-backfill.json")
const LOG_PATH = join(HOME, "x-like-backfill.jsonl")
const AGENT_ROOT = join(HOME, "agent")

const FIRST_BASE_MS = 40 * 60_000
const FIRST_JITTER_MS = 15 * 60_000
const FIRST_MIN_MS = 25 * 60_000
const FIRST_MAX_MS = 55 * 60_000
const LATER_BASE_MS = 2 * 60 * 60_000
const LATER_JITTER_MS = 40 * 60_000
const LATER_MIN_MS = 80 * 60_000
const LATER_MAX_MS = 160 * 60_000

const cmd = process.argv[2] ?? "tick"

function dist(rel) {
  return pathToFileURL(join(RUNTIME, rel)).href
}

function nowIso() {
  return new Date().toISOString()
}

function jitteredDelayMs(baseMs, jitterMs, minMs, maxMs) {
  const delta = randomInt(0, jitterMs * 2 + 1) - jitterMs
  return Math.min(maxMs, Math.max(minMs, baseMs + delta))
}

function firstDelayMs() {
  return jitteredDelayMs(FIRST_BASE_MS, FIRST_JITTER_MS, FIRST_MIN_MS, FIRST_MAX_MS)
}

function laterDelayMs() {
  return jitteredDelayMs(LATER_BASE_MS, LATER_JITTER_MS, LATER_MIN_MS, LATER_MAX_MS)
}

function checkpoint(event) {
  appendFileSync(LOG_PATH, `${JSON.stringify({ ts: nowIso(), ...event })}\n`)
}

async function loadRuntime() {
  const [
    { StateStore },
    { recoverXBotHealth, xBotHealthEscalation },
    { executeEngagementActions },
    { engagementActionId },
    { likesInWindow },
    { WorkspaceLock, agentLockPath },
    { isDeployPaused },
    { loadXSessionHold, xSessionHoldPath },
    { writeAtomicFile },
    { loadConfig },
  ] = await Promise.all([
    import(dist("lib/state.js")),
    import(dist("orchestrator/x-bot-health.js")),
    import(dist("collectors/twitter/engagement.js")),
    import(dist("social/x-engagement.js")),
    import(dist("social/x-engagement.js")),
    import(dist("lib/lock.js")),
    import(dist("lib/deploy-pause.js")),
    import(dist("collectors/twitter/session-hold.js")),
    import(dist("lib/fs-atomic.js")),
    import(dist("lib/config.js")),
  ])
  return {
    StateStore,
    recoverXBotHealth,
    xBotHealthEscalation,
    executeEngagementActions,
    engagementActionId,
    likesInWindow,
    WorkspaceLock,
    agentLockPath,
    isDeployPaused,
    loadXSessionHold,
    xSessionHoldPath,
    writeAtomicFile,
    loadConfig,
  }
}

function parseRunIso(runId) {
  const match = /^list-scan-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/u.exec(runId)
  if (!match) return undefined
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function collectQueueItems(engagement) {
  const liked = new Set(engagement.likedPostIds ?? [])
  const followed = new Set((engagement.followedHandles ?? []).map((h) => h.toLowerCase()))
  const receiptedLikes = new Set(
    (engagement.receipts ?? [])
      .filter((r) => r.action === "like")
      .map((r) => r.target),
  )
  const receiptedFollows = new Set(
    (engagement.receipts ?? [])
      .filter((r) => r.action === "follow")
      .map((r) => String(r.target).toLowerCase()),
  )
  const reports = join(AGENT_ROOT, "reports")
  const items = []
  const seenLike = new Set()
  const seenFollow = new Set()

  for (const name of readdirSync(reports)) {
    if (!name.startsWith("list-scan-")) continue
    const hostPath = join(reports, name, "x-engagement-host.json")
    if (!existsSync(hostPath)) continue
    let host
    try {
      host = readJson(hostPath)
    } catch {
      continue
    }
    if (!host.botHealthBlocked) continue
    for (const decision of host.decisions ?? []) {
      if (!decision.accepted) continue
      if (decision.action === "follow") {
        const handle = String(decision.target ?? "").toLowerCase()
        if (!handle || seenFollow.has(handle) || followed.has(handle) || receiptedFollows.has(handle)) {
          continue
        }
        seenFollow.add(handle)
        items.push({
          kind: "follow",
          target: handle,
          sourceRunId: decision.runId ?? name,
          reasonCode: decision.reasonCode ?? "narrative_signal",
          topics: decision.topics ?? [],
          decidedAt: decision.decidedAt,
          status: "pending",
        })
      }
      if (decision.action === "like") {
        const postId = String(decision.target ?? "")
        if (!/^\d{5,25}$/u.test(postId)) continue
        if (seenLike.has(postId) || liked.has(postId) || receiptedLikes.has(postId)) continue
        seenLike.add(postId)
        items.push({
          kind: "like",
          target: postId,
          sourceRunId: decision.runId ?? name,
          reasonCode: decision.reasonCode ?? "backfill",
          topics: decision.topics ?? [],
          decidedAt: decision.decidedAt,
          status: "pending",
        })
      }
    }
  }

  items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "follow" ? -1 : 1
    return String(a.decidedAt ?? "").localeCompare(String(b.decidedAt ?? ""))
  })
  return items
}

function queueStats(items) {
  const stats = { pending: 0, done: 0, skipped: 0, failed: 0 }
  for (const item of items) {
    stats[item.status] = (stats[item.status] ?? 0) + 1
  }
  return stats
}

async function saveQueue(writeAtomicFile, queue) {
  queue.updatedAt = nowIso()
  queue.stats = queueStats(queue.items)
  await writeAtomicFile(STATE_PATH, `${JSON.stringify(queue, null, 2)}\n`)
}

function loadQueue() {
  if (!existsSync(STATE_PATH)) return undefined
  return readJson(STATE_PATH)
}

function printStatus(queue, extra) {
  const pending = (queue.items ?? []).filter((i) => i.status === "pending")
  const next = pending[0]
  console.log(JSON.stringify({
    paused: queue.paused ?? false,
    pauseReason: queue.pauseReason,
    nextDueAt: queue.nextDueAt,
    next: next ? { kind: next.kind, target: next.target, sourceRunId: next.sourceRunId } : null,
    stats: queue.stats ?? queueStats(queue.items ?? []),
    recoveredAt: queue.recoveredAt,
    ...extra,
  }, null, 2))
}

async function cmdInit(rt) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 })
  const agentLock = new rt.WorkspaceLock(rt.agentLockPath(AGENT_ROOT))
  if (!agentLock.tryAcquire()) {
    console.error("agent workspace is locked")
    process.exit(3)
  }
  try {
    const state = new rt.StateStore(join(AGENT_ROOT, "state"))
    const recovered = await rt.recoverXBotHealth({ state, nowIso: nowIso() })
    const engagement = state.loadXEngagement()
    const items = collectQueueItems(engagement)
    const dueAt = new Date(Date.parse(nowIso()) + firstDelayMs()).toISOString()
    const queue = {
      schema: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      recoveredAt: recovered.updatedAt,
      consecutiveFailuresBefore: 3,
      paused: false,
      nextDueAt: items.length > 0 ? dueAt : null,
      items,
      stats: queueStats(items),
    }
    await rt.writeAtomicFile(STATE_PATH, `${JSON.stringify(queue, null, 2)}\n`)
    checkpoint({
      event: "init",
      recoveredAt: recovered.updatedAt,
      consecutiveFailures: recovered.consecutiveFailures,
      pending: queue.stats.pending,
      follows: items.filter((i) => i.kind === "follow").length,
      likes: items.filter((i) => i.kind === "like").length,
      nextDueAt: queue.nextDueAt,
    })
    printStatus(queue, { consecutiveFailures: recovered.consecutiveFailures })
  } finally {
    agentLock.release()
  }
}

function dayKey(iso) {
  return iso.slice(0, 10)
}

function ensureDaily(file, iso) {
  const day = dayKey(iso)
  if (file.daily?.day === day) return file
  return {
    ...file,
    daily: { day, likes: 0, follows: 0, unfollows: 0 },
  }
}

async function applyVerified(state, decision, receipt, iso) {
  const after = ensureDaily(state.loadXEngagement(), iso)
  const followed = new Set(after.followedHandles.map((h) => h.toLowerCase()))
  const liked = new Set(after.likedPostIds)
  const lastLikedAt = { ...after.lastLikedAt }
  const lastFollowedAt = { ...after.lastFollowedAt }
  const daily = { ...after.daily }
  if (decision.action === "like") {
    liked.add(decision.target)
    lastLikedAt[decision.target] = iso
    daily.likes += 1
  } else if (decision.action === "follow") {
    followed.add(decision.target.toLowerCase())
    lastFollowedAt[decision.target.toLowerCase()] = iso
    daily.follows += 1
  }
  await state.saveXEngagement({
    ...after,
    followedHandles: [...followed].sort(),
    likedPostIds: [...liked].sort(),
    lastLikedAt,
    lastFollowedAt,
    daily,
    decisions: [...after.decisions, decision],
    receipts: [...after.receipts, receipt],
  })
}

async function cmdTick(rt) {
  if (rt.isDeployPaused(HOME)) {
    checkpoint({ event: "skip", reason: "deploy-paused" })
    return
  }
  if (rt.loadXSessionHold(rt.xSessionHoldPath(HOME))) {
    checkpoint({ event: "skip", reason: "x-session-held" })
    return
  }
  const queue = loadQueue()
  if (!queue) {
    checkpoint({ event: "skip", reason: "no-queue" })
    return
  }
  if (queue.paused) {
    checkpoint({ event: "skip", reason: "paused", pauseReason: queue.pauseReason })
    return
  }
  const pending = queue.items.filter((i) => i.status === "pending")
  if (pending.length === 0) {
    checkpoint({ event: "skip", reason: "queue-empty" })
    return
  }
  if (!queue.nextDueAt || Date.parse(nowIso()) < Date.parse(queue.nextDueAt)) {
    return
  }

  const tickLock = new rt.WorkspaceLock(join(HOME, "locks", "x-like-backfill.lock"))
  if (!tickLock.tryAcquire()) {
    checkpoint({ event: "skip", reason: "tick-lock" })
    return
  }
  const agentLock = new rt.WorkspaceLock(rt.agentLockPath(AGENT_ROOT))
  if (!agentLock.tryAcquire()) {
    tickLock.release()
    checkpoint({ event: "skip", reason: "agent-lock" })
    return
  }

  try {
    const state = new rt.StateStore(join(AGENT_ROOT, "state"))
    const health = state.loadXBotHealth(nowIso())
    if (rt.xBotHealthEscalation(health).escalate) {
      queue.paused = true
      queue.pauseReason = "x-bot-blocked"
      await saveQueue(rt.writeAtomicFile, queue)
      checkpoint({ event: "pause", reason: "x-bot-blocked" })
      return
    }

    const item = pending[0]
    const engagement = state.loadXEngagement()
    const iso = nowIso()
    if (item.kind === "like") {
      if ((engagement.likedPostIds ?? []).includes(item.target)) {
        item.status = "skipped"
        item.result = "already-liked"
        queue.nextDueAt = new Date(Date.parse(iso) + laterDelayMs()).toISOString()
        await saveQueue(rt.writeAtomicFile, queue)
        checkpoint({ event: "skip-item", kind: item.kind, target: item.target, result: item.result })
        return
      }
      const cfg = rt.loadConfig()
      if (rt.likesInWindow(engagement, iso, cfg.twitter.engagement.like_window_minutes)
        >= cfg.twitter.engagement.likes_per_window) {
        checkpoint({ event: "skip", reason: "like-throttle" })
        return
      }
    }
    if (item.kind === "follow") {
      const handles = new Set((engagement.followedHandles ?? []).map((h) => h.toLowerCase()))
      if (handles.has(item.target)) {
        item.status = "skipped"
        item.result = "already-following"
        queue.nextDueAt = new Date(Date.parse(iso) + laterDelayMs()).toISOString()
        await saveQueue(rt.writeAtomicFile, queue)
        checkpoint({ event: "skip-item", kind: item.kind, target: item.target, result: item.result })
        return
      }
    }

    const runId = `x-like-backfill-${item.kind}-${item.target}`
    const proposalItem = item.kind === "like"
      ? {
        action: "like",
        postId: item.target,
        authorHandle: "backfill",
        reasonCode: item.reasonCode,
        topics: item.topics,
        rationale: "operator health-block catch-up",
      }
      : {
        action: "follow",
        handle: item.target,
        reasonCode: item.reasonCode,
        topics: item.topics,
        rationale: "operator health-block catch-up",
      }
    const decision = {
      schema: 1,
      actionId: rt.engagementActionId(proposalItem, runId),
      action: item.kind,
      target: item.target,
      reasonCode: item.reasonCode,
      topics: item.topics,
      accepted: true,
      runId,
      decidedAt: iso,
    }

    checkpoint({ event: "attempt", kind: item.kind, target: item.target, sourceRunId: item.sourceRunId })
    let executed
    try {
      executed = await rt.executeEngagementActions({
        accepted: [decision],
        nowIso: iso,
        headless: true,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/challenge|login/iu.test(message)) {
        queue.paused = true
        queue.pauseReason = message.slice(0, 180)
        queue.nextDueAt = null
        await saveQueue(rt.writeAtomicFile, queue)
        checkpoint({ event: "pause", reason: queue.pauseReason })
        return
      }
      queue.nextDueAt = new Date(Date.parse(iso) + laterDelayMs()).toISOString()
      await saveQueue(rt.writeAtomicFile, queue)
      checkpoint({
        event: "retry",
        kind: item.kind,
        target: item.target,
        error: message.slice(0, 180),
        nextDueAt: queue.nextDueAt,
      })
      return
    }
    const receipt = executed.receipts[0]
    // INV-S22 likes must be same-run FYP. Backfill must not escalate bot health

    const verified = Boolean(receipt?.verified && !receipt?.ambiguous)
    item.attemptedAt = iso
    item.outcome = receipt?.outcome
    item.verified = receipt?.verified
    item.ambiguous = receipt?.ambiguous
    if (verified) {
      await applyVerified(state, decision, receipt, iso)
      item.status = "done"
      item.result = receipt.outcome ?? "verified"
      const remain = queue.items.filter((i) => i.status === "pending" && i !== item)
      queue.nextDueAt = remain.length > 0
        ? new Date(Date.parse(iso) + laterDelayMs()).toISOString()
        : null
      await saveQueue(rt.writeAtomicFile, queue)
      checkpoint({
        event: "done",
        kind: item.kind,
        target: item.target,
        outcome: item.result,
        nextDueAt: queue.nextDueAt,
        pending: remain.length,
      })
      return
    }

    item.status = "failed"
    item.result = receipt?.error ?? receipt?.verificationError ?? receipt?.outcome ?? "unverified"
    queue.paused = true
    queue.pauseReason = `unverified:${item.result}`.slice(0, 180)
    queue.nextDueAt = null
    await saveQueue(rt.writeAtomicFile, queue)
    checkpoint({
      event: "pause",
      kind: item.kind,
      target: item.target,
      reason: queue.pauseReason,
    })
  } finally {
    agentLock.release()
    tickLock.release()
  }
}

async function cmdStatus() {
  const queue = loadQueue()
  if (!queue) {
    console.log(JSON.stringify({ error: "no-queue" }))
    process.exit(2)
  }
  printStatus(queue, {})
}

const HANDLE_RE = /^[a-zA-Z0-9_]{1,15}$/u
const FOLLOW_AFTER_LIKES = 25

function collectAuthorLikes() {
  const postsByAuthor = new Map()
  const postAuthor = {}
  const reports = join(AGENT_ROOT, "reports")
  for (const name of readdirSync(reports)) {
    if (!name.startsWith("list-scan-")) continue
    const agentPath = join(reports, name, "x-engagement.json")
    if (!existsSync(agentPath)) continue
    let proposal
    try {
      proposal = readJson(agentPath)
    } catch {
      continue
    }
    for (const item of proposal.items ?? []) {
      if (item.action !== "like") continue
      const postId = String(item.postId ?? "")
      const handle = String(item.authorHandle ?? "").replace(/^@/u, "").toLowerCase()
      if (!/^\d{5,25}$/u.test(postId)) continue
      if (!HANDLE_RE.test(handle)) continue
      postAuthor[postId] = handle
      if (!postsByAuthor.has(handle)) postsByAuthor.set(handle, new Set())
      postsByAuthor.get(handle).add(postId)
    }
  }
  return { postsByAuthor, postAuthor }
}

async function cmdSpliceFollows(rt) {
  const queue = loadQueue()
  if (!queue) {
    console.error("no-queue")
    process.exit(2)
  }
  const agentLock = new rt.WorkspaceLock(rt.agentLockPath(AGENT_ROOT))
  if (!agentLock.tryAcquire()) {
    console.error("agent workspace is locked")
    process.exit(3)
  }
  try {
    const { postsByAuthor, postAuthor } = collectAuthorLikes()
    const state = new rt.StateStore(join(AGENT_ROOT, "state"))
    const engagement = state.loadXEngagement()
    const followed = new Set((engagement.followedHandles ?? []).map((h) => h.toLowerCase()))

    for (const item of queue.items) {
      if (item.kind !== "like") continue
      const handle = (postAuthor[item.target] ?? item.authorHandle ?? "").toLowerCase()
      if (!handle) continue
      item.authorHandle = handle
      if (!postsByAuthor.has(handle)) postsByAuthor.set(handle, new Set())
      postsByAuthor.get(handle).add(item.target)
    }

    const due = []
    for (const [handle, posts] of postsByAuthor) {
      if (posts.size >= FOLLOW_AFTER_LIKES && !followed.has(handle)) {
        due.push({ handle, likes: posts.size })
      }
    }
    due.sort((a, b) => a.handle.localeCompare(b.handle))

    const already = new Set(
      queue.items
        .filter((item) => item.kind === "follow")
        .map((item) => String(item.target).toLowerCase()),
    )
    const toAdd = due.filter((row) => !already.has(row.handle))

    const pending = queue.items.filter((item) => item.status === "pending")
    const rest = queue.items.filter((item) => item.status !== "pending")
    for (const row of toAdd) {
      pending.splice(randomInt(0, pending.length + 1), 0, {
        kind: "follow",
        target: row.handle,
        sourceRunId: "x-like-backfill-threshold",
        reasonCode: "like_threshold",
        topics: [],
        status: "pending",
      })
    }
    queue.items = [...rest, ...pending]
    await saveQueue(rt.writeAtomicFile, queue)
    checkpoint({
      event: "splice-follows",
      threshold: FOLLOW_AFTER_LIKES,
      due: due.length,
      added: toAdd.length,
      handles: toAdd.map((row) => row.handle),
      pending: queue.stats.pending,
    })
    printStatus(queue, {
      thresholdFollowsDue: due,
      added: toAdd.map((row) => row.handle),
    })
  } finally {
    agentLock.release()
  }
}

const rt = await loadRuntime()
if (cmd === "init") await cmdInit(rt)
else if (cmd === "tick") await cmdTick(rt)
else if (cmd === "status") await cmdStatus()
else if (cmd === "splice-follows") await cmdSpliceFollows(rt)
else {
  console.error("usage: x-like-backfill.mjs <init|tick|status|splice-follows>")
  process.exit(2)
}
