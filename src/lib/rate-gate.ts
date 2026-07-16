export type RateGateOptions = Readonly<{
  capacity: number
  refillPerSecond: number
  monthlyBudget?: number
}>

export class RateGate {
  private tokens: number
  private lastRefillMs: number
  private monthlyUsed = 0
  private monthKey = currentMonthKey()

  constructor(
    private readonly host: string,
    private readonly options: RateGateOptions,
  ) {
    this.tokens = options.capacity
    this.lastRefillMs = Date.now()
  }

  async take(cost = 1): Promise<void> {
    this.rotateMonthIfNeeded()
    if (
      this.options.monthlyBudget !== undefined
      && this.monthlyUsed + cost > this.options.monthlyBudget
    ) {
      throw new Error(`Monthly budget exhausted for ${this.host}`)
    }

    for (;;) {
      this.refill()
      if (this.tokens >= cost) {
        this.tokens -= cost
        this.monthlyUsed += cost
        return
      }
      const deficit = cost - this.tokens
      const waitMs = Math.ceil((deficit / this.options.refillPerSecond) * 1_000)
      await sleep(Math.min(Math.max(waitMs, 20), 5_000))
    }
  }

  observe429(retryAfterSeconds?: number): void {
    this.tokens = 0
    if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)) {
      this.lastRefillMs = Date.now() + Math.ceil(retryAfterSeconds * 1_000)
    }
  }

  snapshot(): Readonly<{ host: string; tokens: number; monthlyUsed: number }> {
    return {
      host: this.host,
      tokens: this.tokens,
      monthlyUsed: this.monthlyUsed,
    }
  }

  private refill(): void {
    const now = Date.now()
    if (now <= this.lastRefillMs) return
    const elapsedSec = (now - this.lastRefillMs) / 1_000
    this.tokens = Math.min(
      this.options.capacity,
      this.tokens + elapsedSec * this.options.refillPerSecond,
    )
    this.lastRefillMs = now
  }

  private rotateMonthIfNeeded(): void {
    const key = currentMonthKey()
    if (key !== this.monthKey) {
      this.monthKey = key
      this.monthlyUsed = 0
    }
  }
}

const gates = new Map<string, RateGate>()

export function getRateGate(host: string, options: RateGateOptions): RateGate {
  const existing = gates.get(host)
  if (existing) return existing
  const gate = new RateGate(host, options)
  gates.set(host, gate)
  return gate
}

export function resetRateGatesForTests(): void {
  gates.clear()
}

function currentMonthKey(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
