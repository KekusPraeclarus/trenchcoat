import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { sha256Json } from "../lib/canonical-json.js"
import { buildHealthSnapshot } from "../orchestrator/health.js"
import type { RemediationLayout } from "./paths.js"
import {
  classifyErrorClass,
  sanitizeSecretLike,
  shortIncidentId,
  stableIncidentFingerprint,
} from "./sanitize.js"
import {
  emptyCursorsFile,
  type RemediationStore,
} from "./store.js"
import type {
  LogCursor,
  RemediationCursorsFile,
  RemediationIncident,
  UntrustedEvidence,
} from "./schemas.js"

const LOG_GLOBS = [
  "/tmp/trenchcoat.orchestrator.out.log",
  "/tmp/trenchcoat.orchestrator.err.log",
  "/tmp/trenchcoat.listener.out.log",
  "/tmp/trenchcoat.listener.err.log",
  "/tmp/trenchcoat.x-scan.out.log",
  "/tmp/trenchcoat.x-scan.err.log",
  "/tmp/trenchcoat.channels.out.log",
  "/tmp/trenchcoat.channels.err.log",
  "/tmp/trenchcoat.router.out.log",
  "/tmp/trenchcoat.router.err.log",
]

const EXPECTED_SKIP_CODES = new Set([
  "deploy-pause",
  "precondition-skip",
  "agent-busy",
  "lock-held",
  "quota-exhausted",
])

const MAX_NEW_CANDIDATES = 20
const MAX_LOG_BYTES_PER_SCAN = 256_000

export type IntakeCandidate = Readonly<{
  fingerprint: string
  incidentId: string
  job?: string
  component?: string
  errorClass: string
  title: string
  severity: "info" | "warn" | "error"
  evidence: UntrustedEvidence[]
  deterministicIgnore?: string
}>

function inodeKey(path: string): string | undefined {
  try {
    const st = statSync(path)
    return `${st.dev}:${st.ino}`
  } catch {
    return undefined
  }
}

function readLogDelta(
  path: string,
  cursor: LogCursor | undefined,
  nowIso: string,
): { lines: string[]; next: LogCursor } {
  if (!existsSync(path)) {
    return {
      lines: [],
      next: {
        path,
        size: 0,
        offset: 0,
        updatedAt: nowIso,
      },
    }
  }
  const st = statSync(path)
  const inode = inodeKey(path)
  let offset = cursor?.offset ?? 0
  if (
    !cursor
    || (cursor.inode && inode && cursor.inode !== inode)
    || st.size < offset
  ) {
    offset = 0
  }
  const fdSize = st.size
  const readStart = offset
  const toRead = Math.min(fdSize - readStart, MAX_LOG_BYTES_PER_SCAN)
  if (toRead <= 0) {
    return {
      lines: [],
      next: {
        path,
        ...(inode ? { inode } : {}),
        size: fdSize,
        offset: fdSize,
        updatedAt: nowIso,
      },
    }
  }
  const buf = Buffer.alloc(toRead)
  const fh = readFileSync(path)
  const slice = fh.subarray(readStart, readStart + toRead).toString("utf8")
  void buf
  const lines = slice.split("\n").map((l) => l.trim()).filter(Boolean)
  return {
    lines,
    next: {
      path,
      ...(inode ? { inode } : {}),
      size: fdSize,
      offset: readStart + toRead,
      updatedAt: nowIso,
    },
  }
}

function parseLogLine(line: string): {
  level?: string
  job?: string
  message: string
} | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>
    const message = typeof obj["msg"] === "string"
      ? obj["msg"]
      : typeof obj["message"] === "string"
        ? obj["message"]
        : typeof obj["error"] === "string"
          ? obj["error"]
          : null
    if (!message) return null
    return {
      ...(typeof obj["level"] === "string" ? { level: obj["level"] } : {}),
      ...(typeof obj["job"] === "string" ? { job: obj["job"] } : {}),
      message,
    }
  } catch {
    if (/error|fail|exception/iu.test(line)) {
      return { message: line.slice(0, 500), level: "error" }
    }
    return null
  }
}

function isDeterministicIgnore(args: Readonly<{
  errorClass: string
  message: string
  job?: string
}>): string | undefined {
  const m = args.message.toLowerCase()
  if (EXPECTED_SKIP_CODES.has(args.errorClass)) return "expected-skip"
  if (/deploy.?pause|paused by deploy/u.test(m)) return "deploy-pause"
  if (/lock (held|busy)|contention/u.test(m) && !/fatal|corrupt/u.test(m)) {
    return "bounded-lock"
  }
  if (/precondition/u.test(m) && /skip/u.test(m)) return "precondition-skip"
  if (/transient|retrying|will retry/u.test(m)) return "transient"
  return undefined
}

export async function collectRemediationIntake(args: Readonly<{
  store: RemediationStore
  layout: RemediationLayout
  archiveRoot?: string
  agentRoot?: string
  nowIso: string
  maxEvidenceBytes?: number
}>): Promise<{
  candidates: IntakeCandidate[]
  cursors: RemediationCursorsFile
  healthSummaryPath: string
}> {
  const home = join(homedir(), ".trenchcoat")
  const archiveRoot = args.archiveRoot ?? join(home, "archive")
  const agentRoot = args.agentRoot ?? join(home, "agent")
  const maxEvidence = args.maxEvidenceBytes ?? 100_000

  let cursors = args.store.loadCursors()
  if (!cursors.schema) cursors = emptyCursorsFile()

  const candidates: IntakeCandidate[] = []
  const seen = new Set<string>()

  const health = await buildHealthSnapshot({
    agentRoot,
    archiveRoot,
  })
  const healthPath = join(args.layout.artifacts, "last-health.json")
  const { writeAtomicFileFsync } = await import("../lib/fs-atomic.js")
  const { mkdirSync } = await import("node:fs")
  mkdirSync(args.layout.artifacts, { recursive: true, mode: 0o700 })
  const warnings = health.warnings.slice(0, 20)
  await writeAtomicFileFsync(
    healthPath,
    `${JSON.stringify({
      trust: "host-derived",
      capturedAt: args.nowIso,
      warnings,
    }, null, 2)}\n`,
    0o600,
  )

  for (const warning of warnings.slice(0, 10)) {
    const errorClass = classifyErrorClass(warning)
    const ignore = isDeterministicIgnore({ errorClass, message: warning })
    const fingerprint = stableIncidentFingerprint({
      component: "health",
      errorClass,
      target: sha256Json({ warning: sanitizeSecretLike(warning, 120) }).slice(0, 16),
    })
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    candidates.push({
      fingerprint,
      incidentId: shortIncidentId(fingerprint),
      component: "health",
      errorClass,
      title: sanitizeSecretLike(warning, 200),
      severity: "warn",
      evidence: [{
        schema: 1,
        trust: "untrusted-external",
        kind: "health",
        path: healthPath,
        summary: sanitizeSecretLike(warning, 200),
        capturedAt: args.nowIso,
      }],
      ...(ignore ? { deterministicIgnore: ignore } : {}),
    })
  }

  const nextLogs: LogCursor[] = []
  for (const path of LOG_GLOBS) {
    const prev = cursors.logs.find((c) => c.path === path)
    const { lines, next } = readLogDelta(path, prev, args.nowIso)
    nextLogs.push(next)
    for (const line of lines) {
      if (candidates.length >= MAX_NEW_CANDIDATES) break
      const parsed = parseLogLine(line)
      if (!parsed) continue
      if (parsed.level && !/error|warn|fatal/iu.test(parsed.level)) continue
      const errorClass = classifyErrorClass(parsed.message)
      const ignore = isDeterministicIgnore({
        errorClass,
        message: parsed.message,
        ...(parsed.job ? { job: parsed.job } : {}),
      })
      const fingerprint = stableIncidentFingerprint({
        ...(parsed.job ? { job: parsed.job } : {}),
        component: "log",
        errorClass,
        ...(path.split("/").pop()
          ? { target: path.split("/").pop()! }
          : {}),
      })
      if (seen.has(fingerprint)) continue
      seen.add(fingerprint)
      const summary = sanitizeSecretLike(parsed.message, 200)
      candidates.push({
        fingerprint,
        incidentId: shortIncidentId(fingerprint),
        ...(parsed.job ? { job: parsed.job } : {}),
        component: "log",
        errorClass,
        title: summary,
        severity: /error|fatal/iu.test(parsed.level ?? "error") ? "error" : "warn",
        evidence: [{
          schema: 1,
          trust: "untrusted-external",
          kind: "log-line",
          path,
          summary,
          capturedAt: args.nowIso,
        }],
        ...(ignore ? { deterministicIgnore: ignore } : {}),
      })
    }
  }

  // Skips journal deltas
  const skipsDir = join(archiveRoot, "skips")
  const nextSkipOffsets = { ...cursors.lastSkipOffsets }
  if (existsSync(skipsDir)) {
    for (const name of readdirSync(skipsDir).filter((n) => n.endsWith(".jsonl")).slice(-5)) {
      const path = join(skipsDir, name)
      const prevOff = nextSkipOffsets[name] ?? 0
      try {
        const raw = readFileSync(path, "utf8")
        if (raw.length <= prevOff) {
          nextSkipOffsets[name] = raw.length
          continue
        }
        const delta = raw.slice(prevOff).slice(0, maxEvidence)
        nextSkipOffsets[name] = prevOff + delta.length
        for (const line of delta.split("\n")) {
          if (!line.trim() || candidates.length >= MAX_NEW_CANDIDATES) continue
          try {
            const obj = JSON.parse(line) as Record<string, unknown>
            const code = typeof obj["code"] === "string" ? obj["code"] : "skip"
            if (EXPECTED_SKIP_CODES.has(code)) continue
            const job = typeof obj["job"] === "string" ? obj["job"] : undefined
            const msg = typeof obj["reason"] === "string"
              ? obj["reason"]
              : code
            const errorClass = classifyErrorClass(msg)
            const fingerprint = stableIncidentFingerprint({
              ...(job ? { job } : {}),
              component: "skip",
              errorClass,
              target: code,
            })
            if (seen.has(fingerprint)) continue
            seen.add(fingerprint)
            candidates.push({
              fingerprint,
              incidentId: shortIncidentId(fingerprint),
              ...(job ? { job } : {}),
              component: "skip",
              errorClass,
              title: sanitizeSecretLike(msg, 200),
              severity: "warn",
              evidence: [{
                schema: 1,
                trust: "untrusted-external",
                kind: "skip",
                path,
                summary: sanitizeSecretLike(msg, 200),
                capturedAt: args.nowIso,
              }],
            })
          } catch {
            // ignore malformed skip lines
          }
        }
      } catch {
        // ignore unreadable
      }
    }
  }

  const nextCursors: RemediationCursorsFile = {
    schema: 1,
    logs: nextLogs,
    lastSkipOffsets: nextSkipOffsets,
    ...(cursors.lastTransactionName
      ? { lastTransactionName: cursors.lastTransactionName }
      : {}),
  }

  return {
    candidates,
    cursors: nextCursors,
    healthSummaryPath: healthPath,
  }
}

export function candidateToIncident(
  candidate: IntakeCandidate,
  nowIso: string,
): RemediationIncident {
  return {
    schema: 1,
    incidentId: candidate.incidentId,
    fingerprint: candidate.fingerprint,
    phase: "detected",
    createdAt: nowIso,
    updatedAt: nowIso,
    ...(candidate.job ? { job: candidate.job } : {}),
    ...(candidate.component ? { component: candidate.component } : {}),
    ...(candidate.errorClass ? { errorClass: candidate.errorClass } : {}),
    title: candidate.title,
    severity: candidate.severity,
    attemptCount: 0,
    originMoveRebuilds: 0,
    evidencePaths: candidate.evidence
      .map((e) => e.path)
      .filter((p): p is string => Boolean(p)),
  }
}
