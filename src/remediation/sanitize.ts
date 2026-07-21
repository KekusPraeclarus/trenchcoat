import { createHash } from "node:crypto"

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:api[_-]?key|secret|token|password|private[_-]?key)\s*[:=]\s*['"]?[^\s'"]{8,}/giu,
  /(?:sk|pk|ghp|gho|xox[baprs])-[A-Za-z0-9_-]{10,}/gu,
  /Bearer\s+[A-Za-z0-9._-]{20,}/gu,
  /0x[a-fA-F0-9]{64}/gu,
]

export function sanitizeSecretLike(text: string, maxLen = 2_000): string {
  let out = text
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]")
  }
  if (out.length > maxLen) out = `${out.slice(0, maxLen)}…`
  return out
}

export function classifyErrorClass(message: string): string {
  const m = message.toLowerCase()
  if (/timeout|etimedout|aborterror/u.test(m)) return "timeout"
  if (/econnrefused|enotfound|network|fetch failed/u.test(m)) return "network"
  if (/lock|busy|contention/u.test(m)) return "lock"
  if (/schema|migration|config/u.test(m)) return "config"
  if (/deploy|install-launchd|runtime/u.test(m)) return "deploy"
  if (/rate.?limit|429/u.test(m)) return "rate-limit"
  if (/empty|zero posts|no posts/u.test(m)) return "empty-scrape"
  if (/permission|denied|eacces/u.test(m)) return "permission"
  return "other"
}

export function stableIncidentFingerprint(args: Readonly<{
  job?: string
  component?: string
  errorClass: string
  target?: string
}>): string {
  const body = {
    job: args.job ?? "",
    component: args.component ?? "",
    errorClass: args.errorClass,
    target: args.target ?? "",
  }
  return createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 24)
}

export function shortIncidentId(fingerprint: string): string {
  return `rem-${fingerprint.slice(0, 12)}`
}
