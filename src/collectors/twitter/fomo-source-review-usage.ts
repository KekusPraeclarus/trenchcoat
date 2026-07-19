import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { writeAtomicFile } from "../../lib/fs-atomic.js"

export type FomoSourceReviewPageAttempt = Readonly<{
  attemptId: string
  requestId: string
  endpointFamily: string
  status: "reserved" | "completed" | "failed"
  counted: boolean | "unknown"
  httpStatus?: number
  at: string
}>

export type FomoSourceReviewUsageDay = Readonly<{
  schema: 1
  day: string
  budget: number
  reserved: number
  completedCounted: number
  attempts: FomoSourceReviewPageAttempt[]
}>

function dayPath(archiveRoot: string, day: string): string {
  return join(archiveRoot, "provider-usage", "twitter", "fomo-source-review", `${day}.json`)
}

export function emptyUsageDay(day: string, budget: number): FomoSourceReviewUsageDay {
  return {
    schema: 1,
    day,
    budget,
    reserved: 0,
    completedCounted: 0,
    attempts: [],
  }
}

export function loadUsageDay(
  archiveRoot: string,
  day: string,
  budget: number,
): FomoSourceReviewUsageDay {
  const path = dayPath(archiveRoot, day)
  if (!existsSync(path)) return emptyUsageDay(day, budget)
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<FomoSourceReviewUsageDay>
    if (
      raw.schema !== 1
      || raw.day !== day
      || typeof raw.budget !== "number"
      || typeof raw.reserved !== "number"
      || typeof raw.completedCounted !== "number"
      || !Array.isArray(raw.attempts)
    ) {
      return emptyUsageDay(day, budget)
    }
    return {
      schema: 1,
      day: raw.day,
      budget: Math.min(raw.budget, budget),
      reserved: raw.reserved,
      completedCounted: raw.completedCounted,
      attempts: raw.attempts,
    }
  } catch {
    return emptyUsageDay(day, budget)
  }
}

export async function saveUsageDay(
  archiveRoot: string,
  day: FomoSourceReviewUsageDay,
): Promise<void> {
  await writeAtomicFile(dayPath(archiveRoot, day.day), `${JSON.stringify(day, null, 2)}\n`)
}

export function remainingBudget(day: FomoSourceReviewUsageDay): number {
  return Math.max(0, day.budget - day.reserved)
}

export function canReserve(day: FomoSourceReviewUsageDay, reserveFloor = 50): boolean {
  return remainingBudget(day) > reserveFloor || day.budget <= reserveFloor
}

export function reserveAttempt(
  day: FomoSourceReviewUsageDay,
  args: Readonly<{
    requestId: string
    endpointFamily: string
    at: string
    counted?: boolean | "unknown"
  }>,
): Readonly<{ day: FomoSourceReviewUsageDay, attemptId: string }> {
  if (!canReserve(day) || remainingBudget(day) <= 0) {
    throw new Error("fomo-source-review daily page budget exhausted")
  }
  const attemptId = `att-${randomBytes(6).toString("hex")}`
  const attempt: FomoSourceReviewPageAttempt = {
    attemptId,
    requestId: args.requestId,
    endpointFamily: args.endpointFamily,
    status: "reserved",
    counted: args.counted ?? "unknown",
    at: args.at,
  }
  return {
    attemptId,
    day: {
      ...day,
      reserved: day.reserved + 1,
      attempts: [...day.attempts, attempt].slice(-5_000),
    },
  }
}

export function completeAttempt(
  day: FomoSourceReviewUsageDay,
  args: Readonly<{
    attemptId: string
    ok: boolean
    counted: boolean
    httpStatus?: number
    at: string
  }>,
): FomoSourceReviewUsageDay {
  const attempts = day.attempts.map((attempt) => {
    if (attempt.attemptId !== args.attemptId) return attempt
    return {
      ...attempt,
      status: args.ok ? "completed" as const : "failed" as const,
      counted: args.counted,
      ...(args.httpStatus !== undefined ? { httpStatus: args.httpStatus } : {}),
      at: args.at,
    }
  })
  const completedCounted = attempts.filter(
    (attempt) => attempt.status === "completed" && attempt.counted === true,
  ).length
  return {
    ...day,
    completedCounted,
    attempts,
  }
}
