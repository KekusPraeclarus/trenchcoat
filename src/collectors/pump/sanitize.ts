const SECRET_KEY_RE = /^(set-cookie|authorization|cookie|x-api-key|api[-_]?key|secret|private[-_]?key|mnemonic|seed|wallet|privatekey)$/iu

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Strip cookies, auth headers, and wallet/secret fields from probe captures.
 * Tests import this. Never write unsanitized bodies into the repo.
 */
export function sanitizeCapturedJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCapturedJson(item))
  }
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) continue
    out[key] = sanitizeCapturedJson(nested)
  }
  return out
}
