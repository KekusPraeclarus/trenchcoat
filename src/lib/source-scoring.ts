export type SourceScoreState = Readonly<{
  alpha: number
  beta: number
  updatedAtMs: number
}>

export function initialSourceScore(priorStrength: number): SourceScoreState {
  const half = priorStrength / 2
  return { alpha: half, beta: half, updatedAtMs: 0 }
}

export function decayScore(
  state: SourceScoreState,
  nowMs: number,
  halfLifeDays: number,
): SourceScoreState {
  if (state.updatedAtMs === 0) return { ...state, updatedAtMs: nowMs }
  const elapsedDays = Math.max(0, (nowMs - state.updatedAtMs) / (86_400_000))
  const factor = Math.pow(0.5, elapsedDays / halfLifeDays)
  const prior = (state.alpha + state.beta) / 2
  return {
    alpha: prior + (state.alpha - prior) * factor,
    beta: prior + (state.beta - prior) * factor,
    updatedAtMs: nowMs,
  }
}

export function observeHit(state: SourceScoreState, hit: boolean, nowMs: number): SourceScoreState {
  return {
    alpha: state.alpha + (hit ? 1 : 0),
    beta: state.beta + (hit ? 0 : 1),
    updatedAtMs: nowMs,
  }
}

export function meanScore(state: SourceScoreState): number {
  const denom = state.alpha + state.beta
  if (denom <= 0) return 0.5
  return state.alpha / denom
}

export type IntentVerdict = "shill" | "warn"

export function parseIntentVerdict(raw: string): IntentVerdict {
  const token = raw.trim().toLowerCase().split(/\s+/u)[0]
  return token === "warn" ? "warn" : "shill"
}
