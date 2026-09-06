import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import {
  GrokIntakePayloadSchema,
  type GrokIntakePayload,
} from "../contracts/schemas.js"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export function isDeskTicketId(value: string): boolean {
  return UUID_RE.test(value)
}

function readTickets(logPath: string): GrokIntakePayload[] {
  if (!existsSync(logPath)) return []
  const raw = readFileSync(logPath, "utf8")
  const tickets: GrokIntakePayload[] = []
  const seen = new Set<string>()
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed) as unknown
    } catch {
      continue
    }
    const ticket = GrokIntakePayloadSchema.safeParse(parsed)
    if (!ticket.success) continue
    if (seen.has(ticket.data.id)) continue
    seen.add(ticket.data.id)
    tickets.push(ticket.data)
  }
  return tickets
}

export function appendDeskTicket(
  logPath: string,
  ticket: GrokIntakePayload,
): "appended" | "duplicate" {
  const parsed = GrokIntakePayloadSchema.parse(ticket)
  const existing = readTickets(logPath)
  if (existing.some((row) => row.id === parsed.id)) return "duplicate"
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
  try {
    appendFileSync(logPath, `${JSON.stringify(parsed)}\n`, { encoding: "utf8", mode: 0o600 })
  } catch (error) {
    const detail = error instanceof Error ? error.message : "write-failed"
    throw Object.assign(new Error(`desk-queue-append-failed:${detail.slice(0, 80)}`), {
      retryable: true,
    })
  }
  return "appended"
}

export function readDeskPending(
  logPath: string,
  sinceId: string | undefined,
  limit: number,
): GrokIntakePayload[] {
  const cap = Math.min(Math.max(1, Math.floor(limit)), 50)
  const tickets = readTickets(logPath)
  if (!sinceId) return tickets.slice(0, cap)
  const index = tickets.findIndex((row) => row.id === sinceId)
  if (index < 0) return tickets.slice(0, cap)
  return tickets.slice(index + 1, index + 1 + cap)
}
