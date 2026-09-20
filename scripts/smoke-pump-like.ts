/**
 * One-shot live like against a visible FYP callout.
 * Gated by TRENCHCOAT_LIVE_PUMP=1. Does not write agent state.
 */
import { PumpEngagementSession } from "../src/collectors/pump/engagement.js"

async function main(): Promise<void> {
  if (process.env["TRENCHCOAT_LIVE_PUMP"] !== "1") {
    console.error("Set TRENCHCOAT_LIVE_PUMP=1 to run live pump.fun like smoke")
    process.exit(2)
  }
  const session = new PumpEngagementSession()
  try {
    const result = await session.likeFirstVisible()
    console.log(JSON.stringify(result))
    if (!result.found) process.exitCode = 2
    else if (!result.verified) process.exitCode = 1
  } finally {
    await session.close()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
