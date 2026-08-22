import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { executeEngagementActions } from "../src/collectors/twitter/engagement.js"
import { sha256Json } from "../src/lib/canonical-json.js"

const agentRoot = join(homedir(), ".trenchcoat", "agent")
const statePath = join(agentRoot, "state", "x-engagement.json")
const prior = JSON.parse(readFileSync(statePath, "utf8")) as {
  followedHandles: string[]
}
const target = (process.env["LIVE_X_REVERSIBLE_HANDLE"] ?? "").trim().toLowerCase()
if (!target) {
  console.error("ABORT: set LIVE_X_REVERSIBLE_HANDLE to a same-run followed handle")
  process.exit(2)
}
if (!prior.followedHandles.map((h) => h.toLowerCase()).includes(target)) {
  console.error("ABORT: no same-run eligible followed handle to reverse")
  process.exit(2)
}

const nowIso = new Date().toISOString()
const mk = (action: "follow" | "unfollow") => ({
  schema: 1 as const,
  actionId: sha256Json({ runId: "live-acceptance-2026-07-18", action, target }),
  runId: "live-acceptance-2026-07-18",
  action,
  target,
  reasonCode: "live_acceptance_reversible",
  topics: [] as string[],
  accepted: true,
  decidedAt: nowIso,
})

console.log("snapshot prior followed count:", prior.followedHandles.length)
const unfollow = await executeEngagementActions({
  accepted: [mk("unfollow")],
  nowIso,
  headless: true,
})
console.log("unfollow receipts:", JSON.stringify(unfollow.receipts.map((r) => ({
  action: r.action,
  target: r.target,
  verified: r.verified,
  ambiguous: r.ambiguous,
  error: r.error,
}))))
if (unfollow.verifiedActionIds.length !== 1) {
  console.error("ABORT: unfollow not verified")
  writeFileSync(
    "/tmp/trenchcoat-x-reversible-acceptance.json",
    `${JSON.stringify({ ok: false, phase: "unfollow", unfollow }, null, 2)}\n`,
  )
  process.exit(2)
}

const follow = await executeEngagementActions({
  accepted: [mk("follow")],
  nowIso: new Date().toISOString(),
  headless: true,
})
console.log("follow receipts:", JSON.stringify(follow.receipts.map((r) => ({
  action: r.action,
  target: r.target,
  verified: r.verified,
  ambiguous: r.ambiguous,
  error: r.error,
}))))
if (follow.verifiedActionIds.length !== 1) {
  console.error("ABORT: restore follow not verified")
  writeFileSync(
    "/tmp/trenchcoat-x-reversible-acceptance.json",
    `${JSON.stringify({ ok: false, phase: "follow", unfollow, follow }, null, 2)}\n`,
  )
  process.exit(2)
}

const receipt = {
  schema: 1,
  kind: "x-reversible-engagement-acceptance",
  target,
  sourceRunId: "list-scan-2026-07-18T18-36-02-564Z",
  priorFollowed: prior.followedHandles,
  unfollowVerified: true,
  restoreFollowVerified: true,
  receipts: [...unfollow.receipts, ...follow.receipts].map((r) => ({
    action: r.action,
    target: r.target,
    verified: r.verified,
    ambiguous: r.ambiguous,
    ...(r.error ? { error: r.error.slice(0, 200) } : {}),
  })),
  at: new Date().toISOString(),
  ok: true,
}
writeFileSync(
  "/tmp/trenchcoat-x-reversible-acceptance.json",
  `${JSON.stringify(receipt, null, 2)}\n`,
  { mode: 0o600 },
)
console.log(JSON.stringify(receipt, null, 2))
