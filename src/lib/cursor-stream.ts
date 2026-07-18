/** Merge Cursor stream-json assistant chunks (deltas or cumulative snapshots) */
export function applyAssistantDelta(acc: string, next: string): string {
  if (!acc) return next
  if (next.startsWith(acc)) return next
  if (acc.startsWith(next) && next.length < acc.length) return acc
  return acc + next
}

export function extractAssistantText(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined
  const row = event as {
    type?: unknown
    message?: { content?: unknown }
  }
  if (row.type !== "assistant") return undefined
  const content = row.message?.content
  if (!Array.isArray(content)) return undefined
  let text = ""
  for (const part of content) {
    if (
      part
      && typeof part === "object"
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
    ) {
      text += (part as { text: string }).text
    }
  }
  return text.length > 0 ? text : undefined
}

export function extractResultText(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined
  const row = event as {
    type?: unknown
    is_error?: unknown
    result?: unknown
  }
  if (row.type !== "result" || row.is_error === true) return undefined
  return typeof row.result === "string" ? row.result : undefined
}

export function extractStreamError(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined
  const row = event as {
    type?: unknown
    is_error?: unknown
    result?: unknown
    error?: unknown
  }
  if (row.type !== "result" || row.is_error !== true) return undefined
  if (typeof row.result === "string" && row.result.trim()) return row.result
  if (typeof row.error === "string" && row.error.trim()) return row.error
  return "cursor stream reported error"
}

/** Feed NDJSON chunks; invoke onEvent for each complete line */
export function createNdjsonParser(onEvent: (event: unknown) => void): {
  push(chunk: string): void
  flush(): void
} {
  let buffer = ""
  return {
    push(chunk) {
      buffer += chunk
      for (;;) {
        const nl = buffer.indexOf("\n")
        if (nl < 0) break
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        try {
          onEvent(JSON.parse(line) as unknown)
        } catch {
          // ignore malformed stream lines
        }
      }
    },
    flush() {
      const line = buffer.trim()
      buffer = ""
      if (!line) return
      try {
        onEvent(JSON.parse(line) as unknown)
      } catch {
        // ignore trailing garbage
      }
    },
  }
}
