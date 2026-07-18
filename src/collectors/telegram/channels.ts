import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"
import { writeAtomicFileFsync } from "../../lib/fs-atomic.js"
import { log } from "../../lib/log.js"
import { sanitizePathSegment } from "../../lib/snapshot.js"
import type { FetchLike } from "../market/geckoterminal.js"
import {
  fetchTelegramPreview,
  floodWaitMilliseconds,
  writeTelegramQueueMessage,
  type TelegramPreviewMessage,
} from "./collector.js"
import { runGramJsListener, type GramJsListener } from "./listener.js"

const CursorFileSchema = z.object({
  schema: z.literal(1),
  channels: z.record(z.object({
    lastId: z.string().min(1).max(64),
    updatedAt: z.string().datetime(),
  })).default({}),
})

export type ChannelCursorFile = z.infer<typeof CursorFileSchema>

export type TelegramChannelConfig = Readonly<{
  channel: string
  mode: "preview" | "gramjs"
}>

export function telegramChannelsHome(home = join(homedir(), ".trenchcoat")): string {
  return join(home, "telegram-channels")
}

export function telegramSessionDir(home = join(homedir(), ".trenchcoat")): string {
  return join(home, "telegram-session")
}

export function telegramSessionPath(home = join(homedir(), ".trenchcoat")): string {
  return join(telegramSessionDir(home), "session.txt")
}

export function cursorsPath(home = join(homedir(), ".trenchcoat")): string {
  return join(telegramChannelsHome(home), "cursors.json")
}

export function loadChannelCursors(path: string): ChannelCursorFile {
  if (!existsSync(path)) return { schema: 1, channels: {} }
  try {
    return CursorFileSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return { schema: 1, channels: {} }
  }
}

export async function saveChannelCursors(
  path: string,
  file: ChannelCursorFile,
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  await writeAtomicFileFsync(path, `${JSON.stringify(file, null, 2)}\n`)
}

export async function acceptChannelMessage(args: Readonly<{
  agentRoot: string
  message: TelegramPreviewMessage
  cursorsFilePath: string
  nowIso?: string
}>): Promise<Readonly<{ written: boolean; cursorAdvanced: boolean }>> {
  const channel = sanitizePathSegment(args.message.channel)
  const result = await writeTelegramQueueMessage(args.agentRoot, {
    ...args.message,
    channel,
  })
  // Checkpoint every accepted (or already-present) message so restart resumes without re-fetch loops
  const nowIso = args.nowIso ?? new Date().toISOString()
  const cursors = loadChannelCursors(args.cursorsFilePath)
  const prev = cursors.channels[channel]
  const prevNum = prev ? Number(prev.lastId) : 0
  const nextNum = Number(args.message.id)
  const shouldAdvance = Number.isFinite(nextNum)
    && (!Number.isFinite(prevNum) || nextNum >= prevNum || !prev)
  if (shouldAdvance) {
    cursors.channels[channel] = { lastId: args.message.id, updatedAt: nowIso }
    await saveChannelCursors(args.cursorsFilePath, cursors)
  }
  return { written: result.written, cursorAdvanced: shouldAdvance }
}

export async function pollPreviewChannel(args: Readonly<{
  agentRoot: string
  channel: string
  fetcher: FetchLike
  cursorsFilePath: string
  nowIso?: string
}>): Promise<Readonly<{ accepted: number; newestId?: string }>> {
  const channel = sanitizePathSegment(args.channel)
  const cursors = loadChannelCursors(args.cursorsFilePath)
  const lastId = cursors.channels[channel]?.lastId
  const messages = await fetchTelegramPreview(args.fetcher, channel)
  const sorted = [...messages].sort((a, b) => Number(a.id) - Number(b.id))
  let accepted = 0
  let newestId: string | undefined
  for (const message of sorted) {
    if (lastId && Number(message.id) <= Number(lastId)) continue
    try {
      const result = await acceptChannelMessage({
        agentRoot: args.agentRoot,
        message,
        cursorsFilePath: args.cursorsFilePath,
        ...(args.nowIso ? { nowIso: args.nowIso } : {}),
      })
      if (result.written || result.cursorAdvanced) {
        accepted += 1
        newestId = message.id
      }
    } catch (error) {
      const wait = floodWaitMilliseconds(error)
      if (wait !== undefined) {
        log.warn("telegram preview flood wait", { channel, waitMs: wait })
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      throw error
    }
  }
  return { accepted, ...(newestId ? { newestId } : {}) }
}

export async function runTelegramChannelsListener(args: Readonly<{
  agentRoot: string
  channels: readonly TelegramChannelConfig[]
  fetcher?: FetchLike
  home?: string
  pollIntervalMs?: number
  signal?: AbortSignal
  gramJsListener?: GramJsListener
}>): Promise<void> {
  const home = args.home ?? join(homedir(), ".trenchcoat")
  const cursorFile = cursorsPath(home)
  mkdirSync(telegramChannelsHome(home), { recursive: true, mode: 0o700 })
  const fetcher = args.fetcher ?? fetch
  const pollMs = args.pollIntervalMs ?? 60_000
  const allowlist = new Map(
    args.channels.map((c) => [sanitizePathSegment(c.channel), c.mode] as const),
  )
  if (allowlist.size === 0) {
    log.warn("telegram channels listener: empty allowlist — idle")
  }

  const previewChannels = [...allowlist.entries()]
    .filter(([, mode]) => mode === "preview")
    .map(([channel]) => channel)
  const gramjsChannels = [...allowlist.entries()]
    .filter(([, mode]) => mode === "gramjs")
    .map(([channel]) => channel)

  if (gramjsChannels.length > 0) {
    const sessionFile = telegramSessionPath(home)
    if (!existsSync(sessionFile)) {
      log.warn("gramjs channels configured but session missing — skipping gramjs until auth", {
        path: sessionFile,
        channels: gramjsChannels.length,
      })
    } else if (!args.gramJsListener) {
      log.warn(
        "gramjs mode requires an injected GramJS listener scaffold — skipping gramjs channels",
        { channels: gramjsChannels.length },
      )
    } else {
      const allowed = new Set(gramjsChannels)
      void runGramJsListener(args.gramJsListener, async (message) => {
        const channel = sanitizePathSegment(message.channel)
        if (!allowed.has(channel)) return
        await acceptChannelMessage({
          agentRoot: args.agentRoot,
          message,
          cursorsFilePath: cursorFile,
        })
      }).catch((error) => {
        log.error("gramjs channel listener failed", {
          detail: error instanceof Error ? error.message : "unknown",
        })
      })
    }
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve, reject) => {
    if (args.signal?.aborted) {
      reject(new Error("aborted"))
      return
    }
    const timer = setTimeout(resolve, ms)
    args.signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(new Error("aborted"))
    }, { once: true })
  })

  log.info("telegram channels listener starting", {
    preview: previewChannels.length,
    gramjs: gramjsChannels.length,
    pollMs,
  })

  while (!args.signal?.aborted) {
    for (const channel of previewChannels) {
      if (args.signal?.aborted) break
      try {
        const result = await pollPreviewChannel({
          agentRoot: args.agentRoot,
          channel,
          fetcher,
          cursorsFilePath: cursorFile,
        })
        if (result.accepted > 0) {
          log.info("telegram preview polled", {
            channel,
            accepted: result.accepted,
            newestId: result.newestId,
          })
        }
      } catch (error) {
        const wait = floodWaitMilliseconds(error)
        if (wait !== undefined) {
          log.warn("telegram channels flood wait", { channel, waitMs: wait })
          await sleep(wait).catch(() => undefined)
          continue
        }
        log.error("telegram preview poll failed", {
          channel,
          detail: error instanceof Error ? error.message : "unknown",
        })
      }
    }
    try {
      await sleep(pollMs)
    } catch {
      break
    }
  }
}

/** Interactive GramJS auth scaffold — stores session string outside agent/ */
export async function authTelegramChannelsSession(args: Readonly<{
  home?: string
  apiId?: number
  apiHash?: string
}>): Promise<Readonly<{ sessionPath: string; created: boolean }>> {
  const home = args.home ?? join(homedir(), ".trenchcoat")
  const dir = telegramSessionDir(home)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const sessionPath = telegramSessionPath(home)
  if (existsSync(sessionPath)) {
    return { sessionPath, created: false }
  }
  const apiId = args.apiId ?? Number(process.env["TELEGRAM_API_ID"] ?? "")
  const apiHash = args.apiHash ?? process.env["TELEGRAM_API_HASH"]
  if (!Number.isFinite(apiId) || apiId <= 0 || !apiHash?.trim()) {
    throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH required for gramjs auth")
  }
  // Full TelegramClient interactive login is deferred; create a placeholder so operators
  // know the path. Replace this file with a real StringSession after manual GramJS login.
  throw new Error(
    `gramjs auth not fully wired — place a StringSession at ${sessionPath} (mode 600) after interactive login with apiId=${apiId}, or use preview mode channels`,
  )
}
