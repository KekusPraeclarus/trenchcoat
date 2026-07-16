export type Clock = Readonly<{
  nowMs: () => number
  nowIso: () => string
}>

export const systemClock: Clock = Object.freeze({
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
})

export function fixedClock(ms: number): Clock {
  return Object.freeze({
    nowMs: () => ms,
    nowIso: () => new Date(ms).toISOString(),
  })
}
