export const CHAT_MODEL_HIGH = "gpt-5.6-sol-low"
export const CHAT_MODEL_MID = "gpt-5.6-terra-medium"
export const CHAT_MODEL_LOW = "cursor-grok-4.5-high"
export const CHAT_DEFAULT_MODEL = "composer-2.5"

/** Tool-enabled Cursor run (omit --mode). Distinct from ask/plan. */
export type ChatExecutionMode = "ask" | "plan" | "agent"

export type ChatTurnDirectives = Readonly<{
  /** Operator text with leading directives stripped */
  body: string
  /** Per-message model override; undefined keeps the durable chat default */
  model?: string
  /** Per-message mode; undefined keeps ask on the durable chat path */
  mode?: ChatExecutionMode
  /** True when any recognized leading directive was consumed */
  hasOverride: boolean
  /** True when body is empty after stripping (host help, no Cursor turn) */
  directiveOnly: boolean
}>

const MODEL_DIRECTIVES = Object.freeze({
  "/model-high": CHAT_MODEL_HIGH,
  "/model-mid": CHAT_MODEL_MID,
  "/model-low": CHAT_MODEL_LOW,
} as const)

const MODE_DIRECTIVES = Object.freeze({
  "/plan": "plan",
  "/agent": "agent",
} as const)

const KNOWN = new Set([
  ...Object.keys(MODEL_DIRECTIVES),
  ...Object.keys(MODE_DIRECTIVES),
])

/**
 * Consume whitespace-separated leading directives only.
 * Last-wins within model and within mode. Directives mid/end of text stay as body.
 */
export function parseChatDirectives(raw: string): ChatTurnDirectives {
  const trimmed = raw.replace(/\u0000/gu, "").trim()
  if (!trimmed) {
    return { body: "", hasOverride: false, directiveOnly: false }
  }

  const tokens = trimmed.split(/\s+/u)
  let model: string | undefined
  let mode: ChatExecutionMode | undefined
  let i = 0
  for (; i < tokens.length; i += 1) {
    const token = tokens[i]!
    const key = token.toLowerCase()
    if (!KNOWN.has(key)) break
    if (key in MODEL_DIRECTIVES) {
      model = MODEL_DIRECTIVES[key as keyof typeof MODEL_DIRECTIVES]
      continue
    }
    if (key in MODE_DIRECTIVES) {
      mode = MODE_DIRECTIVES[key as keyof typeof MODE_DIRECTIVES]
    }
  }

  const body = tokens.slice(i).join(" ").trim()
  const hasOverride = model !== undefined || mode !== undefined
  return {
    body,
    ...(model ? { model } : {}),
    ...(mode ? { mode } : {}),
    hasOverride,
    directiveOnly: hasOverride && body.length === 0,
  }
}

export const CHAT_DIRECTIVE_HELP = [
  "Directives (leading only, last-wins per category):",
  "/model-high — gpt-5.6-sol-low for this message",
  "/model-mid — gpt-5.6-terra-medium for this message",
  "/model-low — cursor-grok-4.5-high for this message",
  "/plan — plan mode on the repo checkout (this message)",
  "/agent — tool-enabled agent mode on the repo checkout (this message)",
  "Default (no directive): composer-2.5 ask mode on the agent workspace.",
].join("\n")
