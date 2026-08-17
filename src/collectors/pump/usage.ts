import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "../../lib/fs-atomic.js"
import { randomBytes } from "node:crypto"

export type PumpNavigationAttempt = Readonly<{
  attemptId: string
  requestId: string
  endpointFamily: string
  status: "reserved" | "completed" | "failed"
  counted: boolean | "unknown"
  httpStatus?: number
  at: string
}>

export type PumpNavigationDay = Readonly<{
  schema: 1
  day: string
  budget: number
  reserved: number
  completedCounted: number
  attempts: PumpNavigationAttempt[]
}>

function dayPath(archiveRoot: string, day: string): string {
  return join(archiveRoot, "provider-usage", "pump", `${day}.json`)
}

export function emptyUsageDay(day: string, budget: number): PumpNavigationDay {
  return {
    schema: 1,
    day,
    budget,
    reserved: 0,
    completedCounted: 0,
    attempts: [],
  }
}

export function loadUsageDay(archiveRoot: string, day: string, budget: number): PumpNavigationDay {
  const path = dayPath(archiveRoot, day)
  if (!existsSync(path)) return emptyUsageDay(day, budget)
  const raw = JSON.parse(readFileSync(path, "utf8")) as PumpNavigationDay
  if (raw.schema !== 1 || raw.day !== day) return emptyUsageDay(day, budget)
  return {
    ...raw,
    budget,
  }
}

export async function saveUsageDay(archiveRoot: string, day: PumpNavigationDay): Promise<void> {
  await writeAtomicFile(dayPath(archiveRoot, day.day), `${JSON.stringify(day, null, 2)}\n`)
}

export function remainingBudget(day: PumpNavigationDay): number {
  return Math.max(0, day.budget - day.reserved)
}

export function canReserve(day: PumpNavigationDay, reserveFloor = 50): boolean {
  return remainingBudget(day) > reserveFloor || day.budget <= reserveFloor
}

export function reserveAttempt(
  day: PumpNavigationDay,
  args: Readonly<{
    requestId: string
    endpointFamily: string
    at: string
    counted?: boolean | "unknown"
  }>,
): Readonly<{ day: PumpNavigationDay, attemptId: string }> {
  if (!canReserve(day)) {
    throw new Error("pump daily budget exhausted")
  }
  const attemptId = `att-${randomBytes(6).toString("hex")}`
  const attempt: PumpNavigationAttempt = {
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
  day: PumpNavigationDay,
  args: Readonly<{
    attemptId: string
    ok: boolean
    counted: boolean
    httpStatus?: number
    at: string
  }>,
): PumpNavigationDay {
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
