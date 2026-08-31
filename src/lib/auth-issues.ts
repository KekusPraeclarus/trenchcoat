import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { z } from "zod"
import { writeAtomicFileFsync } from "./fs-atomic.js"

export const AUTH_ISSUE_SOURCES = ["fomo", "pump", "x"] as const
export type AuthIssueSource = (typeof AUTH_ISSUE_SOURCES)[number]

export const AUTH_ISSUE_KINDS = ["challenge", "session_expired"] as const
export type AuthIssueKind = (typeof AUTH_ISSUE_KINDS)[number]

export const AUTH_ISSUE_ALERT_THRESHOLD = 2

const AuthIssueEntrySchema = z.object({
  kind: z.enum(AUTH_ISSUE_KINDS),
  since: z.string().datetime(),
  detail: z.string().min(1).max(80).optional(),
})

const AuthIssueFileSchema = z.object({
  schema: z.literal(1),
  issues: z.record(z.enum(AUTH_ISSUE_SOURCES), AuthIssueEntrySchema).default({}),
  lastAlert: z.object({
    fingerprint: z.string().min(1).max(40),
    sentAt: z.string().datetime(),
    sources: z.array(z.enum(AUTH_ISSUE_SOURCES)).min(1).max(8),
  }).optional(),
})

export type AuthIssueEntry = z.infer<typeof AuthIssueEntrySchema>
export type AuthIssueFile = z.infer<typeof AuthIssueFileSchema>

export function authIssuesPath(home = join(homedir(), ".trenchcoat")): string {
  return join(home, "auth-issues.json")
}

export function emptyAuthIssueFile(): AuthIssueFile {
  return { schema: 1, issues: {} }
}

export function loadAuthIssueFile(path: string): AuthIssueFile {
  if (!existsSync(path)) return emptyAuthIssueFile()
  try {
    return AuthIssueFileSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return emptyAuthIssueFile()
  }
}

export function openAuthSources(file: AuthIssueFile): AuthIssueSource[] {
  return AUTH_ISSUE_SOURCES.filter((source) => file.issues[source] !== undefined)
}

export function authIssueFingerprint(sources: readonly AuthIssueSource[]): string {
  return [...sources].sort().join("+")
}

export function isSessionAuthFailureCode(code: string): boolean {
  return code === "challenged" || code === "session_expired"
}

export function authKindFromFailureCode(code: string): AuthIssueKind | undefined {
  if (code === "challenged") return "challenge"
  if (code === "session_expired") return "session_expired"
  return undefined
}

export function shouldAlertAuthIssues(file: AuthIssueFile): boolean {
  const sources = openAuthSources(file)
  if (sources.length < AUTH_ISSUE_ALERT_THRESHOLD) return false
  const fingerprint = authIssueFingerprint(sources)
  return file.lastAlert?.fingerprint !== fingerprint
}

function dropStaleAlert(file: AuthIssueFile): AuthIssueFile {
  const fingerprint = authIssueFingerprint(openAuthSources(file))
  if (!file.lastAlert || file.lastAlert.fingerprint === fingerprint) return file
  const next = { ...file }
  delete next.lastAlert
  return next
}

export async function saveAuthIssueFile(path: string, file: AuthIssueFile): Promise<void> {
  await writeAtomicFileFsync(path, `${JSON.stringify(file, null, 2)}\n`)
}

export async function recordAuthIssue(args: Readonly<{
  path: string
  source: AuthIssueSource
  kind: AuthIssueKind
  at: string
  detail?: string
}>): Promise<AuthIssueFile> {
  const current = loadAuthIssueFile(args.path)
  const prior = current.issues[args.source]
  const next: AuthIssueFile = dropStaleAlert({
    ...current,
    issues: {
      ...current.issues,
      [args.source]: {
        kind: args.kind,
        since: prior?.since ?? args.at,
        ...(args.detail ? { detail: args.detail.slice(0, 80) } : {}),
      },
    },
  })
  await saveAuthIssueFile(args.path, next)
  return next
}

export async function clearAuthIssue(args: Readonly<{
  path: string
  source: AuthIssueSource
}>): Promise<AuthIssueFile> {
  const current = loadAuthIssueFile(args.path)
  if (current.issues[args.source] === undefined) return current
  const issues = { ...current.issues }
  delete issues[args.source]
  const next = dropStaleAlert({ ...current, issues })
  await saveAuthIssueFile(args.path, next)
  return next
}

export async function markAuthIssuesAlerted(args: Readonly<{
  path: string
  file: AuthIssueFile
  sentAt: string
}>): Promise<AuthIssueFile> {
  const sources = openAuthSources(args.file)
  const next: AuthIssueFile = {
    ...args.file,
    lastAlert: {
      fingerprint: authIssueFingerprint(sources),
      sentAt: args.sentAt,
      sources,
    },
  }
  await saveAuthIssueFile(args.path, next)
  return next
}

export function renderAuthIssueOperatorNotice(file: AuthIssueFile): string {
  const sources = openAuthSources(file)
  const lines = [
    `Auth warning: ${sources.length} sessions need a new login.`,
    "",
  ]
  for (const source of sources) {
    const issue = file.issues[source]
    if (!issue) continue
    const detail = issue.detail ? ` (${issue.detail})` : ""
    lines.push(`${source}: ${issue.kind}${detail}.`)
  }
  lines.push("")
  if (sources.includes("x")) lines.push("Run tc auth twitter.")
  if (sources.includes("fomo")) lines.push("Run tc auth fomo.")
  if (sources.includes("pump")) lines.push("Run tc auth pump.")
  lines.push("This message is an operator notice.")
  return lines.join("\n")
}
