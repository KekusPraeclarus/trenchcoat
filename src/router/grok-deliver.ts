import type { FetchLike } from "../collectors/market/geckoterminal.js"
import {
  GrokIntakePayloadSchema,
  type GrokIntakePayload,
} from "../contracts/schemas.js"

export const GROK_MAX_ATTEMPTS = 3
export const GROK_CONNECT_TIMEOUT_MS = 10_000
export const GROK_TOTAL_TIMEOUT_MS = 30_000
export const GROK_RETRY_AFTER_CAP_SECONDS = 30

export type GrokDeliveryError = Error & {
  retryable: boolean
  retryAfterSeconds?: number
}

export function validateGrokIntakeUrl(raw: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw Object.assign(new Error("grok intake URL is invalid"), { retryable: false })
  }
  if (parsed.protocol !== "https:") {
    throw Object.assign(new Error("grok intake URL must use HTTPS"), { retryable: false })
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw Object.assign(new Error("grok intake URL cannot contain credentials or a fragment"), {
      retryable: false,
    })
  }
  if (!parsed.hostname) {
    throw Object.assign(new Error("grok intake URL is invalid"), { retryable: false })
  }
  return parsed
}

export function resolveGrokIntakeConfig(env: Readonly<{
  webhookUrl?: string
  senderKey?: string
}>): { webhookUrl: string; senderKey: string } | undefined {
  const webhookUrl = env.webhookUrl?.trim()
  const senderKey = env.senderKey?.trim()
  if (!webhookUrl || !senderKey) return undefined
  try {
    validateGrokIntakeUrl(webhookUrl)
  } catch {
    return undefined
  }
  return { webhookUrl, senderKey }
}

export function grokHttpRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

export function grokBackoffSeconds(
  attempt: number,
  retryAfterSeconds?: number,
): number {
  if (
    retryAfterSeconds !== undefined
    && Number.isFinite(retryAfterSeconds)
    && retryAfterSeconds >= 0
  ) {
    return Math.min(retryAfterSeconds, GROK_RETRY_AFTER_CAP_SECONDS)
  }
  return Math.min(2 ** Math.max(attempt - 1, 0), 8)
}

export function attachGrokTelegramChatId(
  payload: GrokIntakePayload,
  chatId?: string,
): GrokIntakePayload {
  const trimmed = chatId?.trim()
  if (!trimmed) return payload
  return GrokIntakePayloadSchema.parse({
    ...payload,
    telegram: {
      ...(payload.telegram ?? {}),
      chat_id: trimmed,
    },
  })
}

function toGrokError(error: unknown): GrokDeliveryError {
  if (error instanceof Error && typeof (error as GrokDeliveryError).retryable === "boolean") {
    return error as GrokDeliveryError
  }
  const message = error instanceof Error ? error.message : "grok delivery failed"
  const name = error instanceof Error ? error.name : ""
  const retryable = name === "TimeoutError"
    || name === "AbortError"
    || error instanceof TypeError
    || /abort|Timeout|fetch failed/iu.test(message)
  return Object.assign(new Error(message.slice(0, 200)), { retryable })
}

export async function deliverGrok(
  fetcher: FetchLike,
  webhookUrl: string,
  senderKey: string,
  payload: GrokIntakePayload,
): Promise<void> {
  const url = validateGrokIntakeUrl(webhookUrl)
  const body = GrokIntakePayloadSchema.parse(payload)
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${senderKey}`,
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(GROK_TOTAL_TIMEOUT_MS),
  }).catch((error: unknown) => {
    throw toGrokError(error)
  })
  if (response.ok) return
  const retryable = grokHttpRetryable(response.status)
  const retryAfter = Number(response.headers.get("retry-after") ?? NaN)
  const err: GrokDeliveryError = Object.assign(
    new Error(`grok HTTP ${response.status}`),
    { retryable },
  )
  if (retryable && Number.isFinite(retryAfter) && retryAfter >= 0) {
    err.retryAfterSeconds = grokBackoffSeconds(1, retryAfter)
  }
  throw err
}
