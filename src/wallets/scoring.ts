export type WalletEvidence = Readonly<{
  posteriorHitQuality: number
  medianExcessQuality: number
  leadTimeQuality: number
  drawdownAndRugQuality: number
  coverageDiversityActivity: number
}>

export type WalletLlmVote = Readonly<{
  score_0_100: number
  verdict: "promote" | "hold" | "drop"
  reason_code: string
}>

export const HARD_EXCLUSION_REASONS = [
  "contract",
  "program",
  "router",
  "pool",
  "bridge",
  "cex",
  "team",
  "deployer",
  "wash",
  "self-transfer",
  "security-failed",
  "failed-tx",
  "unfinalized",
  "unpriceable",
] as const

export type HardExclusion = typeof HARD_EXCLUSION_REASONS[number]

export function deterministicWalletScore(evidence: WalletEvidence): number {
  const score =
    0.35 * clamp01(evidence.posteriorHitQuality)
    + 0.25 * clamp01(evidence.medianExcessQuality)
    + 0.15 * clamp01(evidence.leadTimeQuality)
    + 0.15 * clamp01(evidence.drawdownAndRugQuality)
    + 0.10 * clamp01(evidence.coverageDiversityActivity)
  return clamp01(score)
}

export function parseWalletVote(raw: unknown): WalletLlmVote {
  if (!raw || typeof raw !== "object") {
    return { score_0_100: 50, verdict: "hold", reason_code: "malformed" }
  }
  const score = Reflect.get(raw, "score_0_100")
  const verdict = Reflect.get(raw, "verdict")
  const reason = Reflect.get(raw, "reason_code")
  if (
    typeof score !== "number"
    || !Number.isFinite(score)
    || score < 0
    || score > 100
    || (verdict !== "promote" && verdict !== "hold" && verdict !== "drop")
    || typeof reason !== "string"
    || reason.length < 1
    || reason.length > 64
  ) {
    return { score_0_100: 50, verdict: "hold", reason_code: "malformed" }
  }
  return { score_0_100: score, verdict, reason_code: reason }
}

export function blendWalletScores(
  deterministic: number,
  llmScore0to100: number,
  detWeight = 0.8,
  llmWeight = 0.2,
): number {
  if (Math.abs(detWeight + llmWeight - 1) > 1e-9) {
    throw new Error("wallet weights must sum to 1")
  }
  return clamp01(detWeight * clamp01(deterministic) + llmWeight * clamp01(llmScore0to100 / 100))
}

export type PromotionInput = Readonly<{
  effectiveBuys: number
  distinctTokens: number
  coverage: number
  deterministic: number
  blended: number
  hitMean: number
  hitLb95: number
  medianExcess: number
  rugExposure: number
  idleDays: number
  hardExclusion?: HardExclusion
}>

export function shouldPromote(input: PromotionInput, thresholds: Readonly<{
  min_effective_buys: number
  min_distinct_tokens: number
  min_coverage: number
  min_deterministic: number
  min_blended: number
  min_hit_mean: number
  min_hit_lb95: number
  min_median_excess: number
  max_rug_exposure: number
  max_idle_days: number
}>): boolean {
  if (input.hardExclusion) return false
  return input.effectiveBuys >= thresholds.min_effective_buys
    && input.distinctTokens >= thresholds.min_distinct_tokens
    && input.coverage >= thresholds.min_coverage
    && input.deterministic >= thresholds.min_deterministic
    && input.blended >= thresholds.min_blended
    && input.hitMean >= thresholds.min_hit_mean
    && input.hitLb95 >= thresholds.min_hit_lb95
    && input.medianExcess >= thresholds.min_median_excess
    && input.rugExposure <= thresholds.max_rug_exposure
    && input.idleDays <= thresholds.max_idle_days
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}
