import type {
  ResearchQueueEntry,
  ResearchQueueFile,
  ResearchTrigger,
} from "../contracts/schemas.js"

const TRIGGER_PRIORITY: Readonly<Record<ResearchTrigger, number>> = {
  operator: 100,
  revisit: 80,
  "wallet-convergence": 70,
  narrative: 55,
  social: 50,
  "new-pools": 40,
}

export function operatorPriority(): number {
  return TRIGGER_PRIORITY.operator
}

export function dedupeKeyFor(entry: Readonly<{
  chain?: string | undefined
  tokenAddress?: string | undefined
  subject: string
}>): string {
  if (entry.chain && entry.tokenAddress) {
    return `${entry.chain}:${entry.tokenAddress}`.toLowerCase()
  }
  return `subject:${entry.subject.trim().toLowerCase()}`
}

export function sortResearchQueue(
  entries: readonly ResearchQueueEntry[],
): ResearchQueueEntry[] {
  return [...entries].sort((a, b) => {
    if (a.trigger !== b.trigger) {
      return TRIGGER_PRIORITY[b.trigger] - TRIGGER_PRIORITY[a.trigger]
    }
    if (a.trigger === "revisit") {
      const aRevisit = a.revisitAfter ? Date.parse(a.revisitAfter) : 0
      const bRevisit = b.revisitAfter ? Date.parse(b.revisitAfter) : 0
      if (aRevisit !== bRevisit) return aRevisit - bRevisit
    }
    if (b.clusterCount !== a.clusterCount) return b.clusterCount - a.clusterCount
    if (a.priority !== b.priority) return b.priority - a.priority
    return Date.parse(a.firstSeen) - Date.parse(b.firstSeen)
  })
}

export function enqueueResearch(
  file: ResearchQueueFile,
  entry: ResearchQueueEntry,
  dailyCap: number,
  day = entry.enqueuedAt.slice(0, 10),
): ResearchQueueFile {
  const base = rolloverCompletedToday(file, day)
  const key = dedupeKeyFor(entry)
  const existing = base.entries.find((e) => dedupeKeyFor(e) === key)
  if (existing) {
    const merged: ResearchQueueEntry = {
      ...existing,
      provenance: [...new Set([...existing.provenance, ...entry.provenance])].slice(0, 32),
      clusterCount: Math.max(existing.clusterCount, entry.clusterCount) + (
        entry.trigger === "operator" ? 0 : 1
      ),
      priority: Math.max(existing.priority, entry.priority),
      trigger: entry.trigger === "operator" || existing.trigger === "operator"
        ? "operator"
        : entry.trigger === "revisit" || existing.trigger === "revisit"
          ? "revisit"
          : entry.trigger === "wallet-convergence" || existing.trigger === "wallet-convergence"
            ? "wallet-convergence"
            : entry.trigger === "narrative" || existing.trigger === "narrative"
              ? "narrative"
              : existing.trigger,
      reason: entry.reason || existing.reason,
      expiresAt: entry.expiresAt,
      ...(entry.chain ? { chain: entry.chain } : {}),
      ...(entry.tokenAddress ? { tokenAddress: entry.tokenAddress } : {}),
      ...(entry.pairAddress ? { pairAddress: entry.pairAddress } : {}),
      ...(entry.symbolDisplay ? { symbolDisplay: entry.symbolDisplay } : {}),
      ...(entry.resolution !== "pending" ? { resolution: entry.resolution } : {}),
      status: existing.status === "done" || existing.status === "rejected"
        ? entry.status
        : existing.status,
    }
    return {
      ...base,
      schema: 1,
      entries: sortResearchQueue([
        ...base.entries.filter((e) => e.queueId !== existing.queueId),
        merged,
      ]),
    }
  }

  if (base.entries.length >= dailyCap * 10) {
    return base
  }

  return {
    ...base,
    schema: 1,
    entries: sortResearchQueue([...base.entries, entry]),
  }
}

/** Reset completedToday when the calendar day advances (first touch wins). */
export function rolloverCompletedToday(
  file: ResearchQueueFile,
  day: string,
): ResearchQueueFile {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) {
    throw new TypeError(`invalid completedToday day: ${day}`)
  }
  if (!file.completedToday) return file
  if (file.completedToday.day === day) return file
  return {
    ...file,
    completedToday: { day, count: 0 },
  }
}

export function todayCompletedCount(
  file: ResearchQueueFile,
  day: string,
): number {
  const rolled = rolloverCompletedToday(file, day)
  if (rolled.completedToday?.day === day) return rolled.completedToday.count
  return 0
}

export function recordCompletedToday(
  file: ResearchQueueFile,
  day: string,
): ResearchQueueFile {
  const rolled = rolloverCompletedToday(file, day)
  const count = todayCompletedCount(rolled, day) + 1
  return {
    ...rolled,
    completedToday: { day, count },
  }
}

export function dequeueDue(
  file: ResearchQueueFile,
  nowIso: string,
  limit: number,
  dailyCap: number,
): { next: ResearchQueueFile; due: ResearchQueueEntry[] } {
  const now = Date.parse(nowIso)
  const day = nowIso.slice(0, 10)
  const rolled = rolloverCompletedToday(file, day)
  const already = todayCompletedCount(rolled, day)
  const remainingCap = Math.max(0, dailyCap - already)
  const take = Math.min(limit, remainingCap)

  const due: ResearchQueueEntry[] = []
  const remain: ResearchQueueEntry[] = []
  const sorted = sortResearchQueue(rolled.entries)

  for (const entry of sorted) {
    const expired = Date.parse(entry.expiresAt) < now
    if (expired) continue
    if (entry.status === "done" || entry.status === "rejected" || entry.status === "expired") {
      continue
    }
    if (entry.status === "ambiguous") {
      remain.push(entry)
      continue
    }
    if (entry.status === "researching") {
      remain.push(entry)
      continue
    }
    if (
      entry.trigger === "revisit"
      && entry.revisitAfter
      && Date.parse(entry.revisitAfter) > now
    ) {
      remain.push(entry)
      continue
    }
    if (entry.security.status === "fail") {
      remain.push({ ...entry, status: "rejected" })
      continue
    }
    if (due.length < take && (entry.status === "pending" || entry.trigger === "operator")) {
      // Keep in-file as researching so markQueueEntry/crash recovery can find it
      const researching = {
        ...entry,
        status: "researching" as const,
        claimedAt: nowIso,
        attemptCount: (entry.attemptCount ?? 0) + 1,
      }
      due.push(researching)
      remain.push(researching)
    } else {
      remain.push(entry)
    }
  }

  return {
    next: {
      ...rolled,
      schema: 1,
      entries: remain,
      completedToday: rolled.completedToday ?? { day, count: 0 },
    },
    due,
  }
}

export function expireQueue(
  file: ResearchQueueFile,
  nowIso: string,
): { next: ResearchQueueFile; expired: ResearchQueueEntry[] } {
  const now = Date.parse(nowIso)
  const day = nowIso.slice(0, 10)
  const rolled = rolloverCompletedToday(file, day)
  const expired: ResearchQueueEntry[] = []
  const remain: ResearchQueueEntry[] = []
  for (const entry of rolled.entries) {
    if (
      Date.parse(entry.expiresAt) < now
      && (entry.status === "pending" || entry.status === "ambiguous")
    ) {
      expired.push({ ...entry, status: "expired" })
    } else {
      remain.push(entry)
    }
  }
  return {
    next: {
      ...rolled,
      schema: 1,
      entries: remain,
      ...(rolled.completedToday ? { completedToday: rolled.completedToday } : {}),
    },
    expired,
  }
}

export function markQueueEntry(
  file: ResearchQueueFile,
  queueId: string,
  patch: Partial<ResearchQueueEntry>,
): ResearchQueueFile {
  return {
    ...file,
    schema: 1,
    entries: file.entries.map((entry) => (
      entry.queueId === queueId ? { ...entry, ...patch } : entry
    )),
  }
}

/** Return researching → pending when a claim lease is stale or a run fails mid-flight. */
export function releaseResearchClaim(
  file: ResearchQueueFile,
  queueId: string,
  args: Readonly<{ nowIso: string; reason?: string }> = { nowIso: new Date().toISOString() },
): ResearchQueueFile {
  return markQueueEntry(file, queueId, {
    status: "pending",
    claimedAt: undefined,
    reason: (args.reason ?? "claim released").slice(0, 280),
  })
}

const DEFAULT_CLAIM_LEASE_MS = 2 * 60 * 60 * 1_000
const DEFAULT_MAX_ATTEMPTS = 5

/** Reclaim stale researching entries so a crashed claim cannot block the queue forever. */
export function recoverStaleResearchClaims(
  file: ResearchQueueFile,
  nowIso: string,
  opts: Readonly<{ leaseMs?: number; maxAttempts?: number }> = {},
): { next: ResearchQueueFile; recovered: ResearchQueueEntry[]; exhausted: ResearchQueueEntry[] } {
  const now = Date.parse(nowIso)
  const leaseMs = opts.leaseMs ?? DEFAULT_CLAIM_LEASE_MS
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const recovered: ResearchQueueEntry[] = []
  const exhausted: ResearchQueueEntry[] = []
  const entries = file.entries.map((entry) => {
    if (entry.status !== "researching") return entry
    const claimedAt = entry.claimedAt ? Date.parse(entry.claimedAt) : NaN
    const stale = !Number.isFinite(claimedAt) || now - claimedAt >= leaseMs
    if (!stale) return entry
    const attempts = entry.attemptCount ?? 1
    if (attempts >= maxAttempts) {
      const rejected = {
        ...entry,
        status: "rejected" as const,
        claimedAt: undefined,
        reason: `research claim exhausted after ${attempts} attempts`.slice(0, 280),
      }
      exhausted.push(rejected)
      return rejected
    }
    const pending = {
      ...entry,
      status: "pending" as const,
      claimedAt: undefined,
      reason: "stale research claim released".slice(0, 280),
    }
    recovered.push(pending)
    return pending
  })
  return {
    next: { ...file, schema: 1, entries },
    recovered,
    exhausted,
  }
}
