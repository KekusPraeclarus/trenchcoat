/**
 * Extract the first top-level JSON object from agent output.
 * Fail closed: no object, unbalanced braces, or invalid JSON throws.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{")
  if (start < 0) {
    throw new Error("No JSON object found in agent output")
  }

  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === "\\") {
        escape = true
        continue
      }
      if (ch === "\"") inString = false
      continue
    }
    if (ch === "\"") {
      inString = true
      continue
    }
    if (ch === "{") depth += 1
    else if (ch === "}") {
      depth -= 1
      if (depth === 0) {
        const slice = text.slice(start, i + 1)
        try {
          return JSON.parse(slice) as unknown
        } catch {
          throw new Error("Malformed JSON object in agent output")
        }
      }
    }
  }
  throw new Error("Unbalanced JSON object in agent output")
}
