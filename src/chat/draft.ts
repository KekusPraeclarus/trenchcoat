import { truncateTelegramText } from "./prompt.js"

export type DraftTransport = Readonly<{
  sendDraft(draftId: number, text: string): Promise<void>
}>

/** Throttled Telegram sendMessageDraft updates; final persistence is separate */
export function createDraftStream(opts: Readonly<{
  transport: DraftTransport
  draftId: number
  minIntervalMs?: number
  nowMs?: () => number
}>): Readonly<{
  begin(): Promise<void>
  update(text: string): Promise<void>
  flush(): Promise<void>
}> {
  const minIntervalMs = opts.minIntervalMs ?? 120
  const nowMs = opts.nowMs ?? Date.now
  let latest = ""
  let lastSent = ""
  let lastSentAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let chain: Promise<void> = Promise.resolve()

  const send = (text: string): Promise<void> => {
    chain = chain.then(async () => {
      const body = truncateTelegramText(text)
      if (body === lastSent && lastSentAt > 0) return
      await opts.transport.sendDraft(opts.draftId, body)
      lastSent = body
      lastSentAt = nowMs()
    }).catch(() => {
      // draft preview is best-effort; final sendMessage still persists
    })
    return chain
  }

  const schedule = (): void => {
    if (timer !== undefined) return
    const wait = Math.max(0, minIntervalMs - (nowMs() - lastSentAt))
    timer = setTimeout(() => {
      timer = undefined
      void send(latest)
    }, wait)
  }

  return {
    async begin() {
      latest = ""
      await send("")
    },
    async update(text) {
      latest = text
      if (nowMs() - lastSentAt >= minIntervalMs) {
        await send(latest)
        return
      }
      schedule()
    },
    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      await send(latest)
    },
  }
}

let nextDraftId = 1

/** Non-zero draft ids; same id animates updates for one reply */
export function allocateDraftId(): number {
  const id = nextDraftId
  nextDraftId = id >= 2_000_000_000 ? 1 : id + 1
  return id
}
