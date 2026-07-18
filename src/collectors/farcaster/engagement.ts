import { gatedFetch, readJsonBody } from "../../lib/http.js"
import { sha256Json } from "../../lib/canonical-json.js"
import type { FetchLike } from "../market/geckoterminal.js"
import type {
  FcEngagementDecision,
  FcEngagementReceipt,
} from "../../contracts/schemas.js"
import { NEYNAR_HOST, NEYNAR_ROOT } from "./neynar.js"

const RATE = { capacity: 100, refillPerSecond: 100 / 60 } as const
const HASH_RE = /^0x[a-fA-F0-9]{40}$/u
const SIGNER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/** Explicit deny list — cast publish and recast must never be reachable */
export const FORBIDDEN_FC_WRITE_PATHS = [
  "/v2/farcaster/cast",
  "/v2/farcaster/cast/",
] as const

export const ALLOWED_FC_WRITE_OPS = [
  "publish_reaction_like",
  "follow_user",
  "unfollow_user",
] as const

export type AllowedFcWriteOp = (typeof ALLOWED_FC_WRITE_OPS)[number]

export function isAllowedFcWriteOp(op: string | undefined): boolean {
  return (ALLOWED_FC_WRITE_OPS as readonly string[]).includes(op ?? "")
}

export function isForbiddenFcWritePath(path: string): boolean {
  const normalized = path.split("?")[0] ?? path
  if (normalized === "/v2/farcaster/cast" || normalized.startsWith("/v2/farcaster/cast/")) {
    // cast search is GET-only and handled elsewhere; any write to cast is forbidden
    return true
  }
  return false
}

function requireSignerUuid(signerUuid: string): string {
  if (!SIGNER_UUID_RE.test(signerUuid)) throw new TypeError("Invalid signer_uuid")
  return signerUuid
}

function requireApiKey(apiKey: string): string {
  const key = apiKey.trim()
  if (!key) throw new Error("Neynar API key is required")
  return key
}

async function neynarWrite(
  fetcher: FetchLike,
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
  method: "POST" | "DELETE" = "POST",
): Promise<unknown> {
  if (isForbiddenFcWritePath(path)) {
    throw new Error(`Forbidden Farcaster write path: ${path}`)
  }
  const url = new URL(path, NEYNAR_ROOT)
  const response = await gatedFetch(
    fetcher,
    url,
    {
      host: NEYNAR_HOST,
      ...RATE,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
    },
    {
      method,
      body: JSON.stringify(body),
    },
  )
  if (!response.ok) {
    let detail = ""
    try {
      const text = await response.text()
      if (text.trim()) detail = `: ${text.slice(0, 200)}`
    } catch {
      // ignore body read failures
    }
    throw new Error(`Neynar write failed with HTTP ${response.status}${detail}`)
  }
  if (response.status === 204) return null
  return readJsonBody(response)
}

export async function getSignerStatus(
  fetcher: FetchLike,
  apiKey: string,
  signerUuid: string,
): Promise<Readonly<{ signerUuid: string, status: string, fid?: number }>> {
  const key = requireApiKey(apiKey)
  const uuid = requireSignerUuid(signerUuid)
  const url = new URL("/v2/farcaster/signer", NEYNAR_ROOT)
  url.searchParams.set("signer_uuid", uuid)
  const response = await gatedFetch(fetcher, url, {
    host: NEYNAR_HOST,
    ...RATE,
    headers: { accept: "application/json", "x-api-key": key },
  })
  if (!response.ok) throw new Error(`Neynar signer status HTTP ${response.status}`)
  const payload = await readJsonBody(response)
  if (payload === null || typeof payload !== "object") {
    throw new TypeError("Neynar signer response must be an object")
  }
  const status = Reflect.get(payload, "status")
  const fid = Reflect.get(payload, "fid")
  if (typeof status !== "string") throw new TypeError("Neynar signer missing status")
  return {
    signerUuid: uuid,
    status: status.toLowerCase(),
    ...(typeof fid === "number" && Number.isInteger(fid) && fid >= 1 ? { fid } : {}),
  }
}

/** Like only — recast is refused (broadcast surface, parallel to X no-retweet). */
export async function publishLike(
  fetcher: FetchLike,
  apiKey: string,
  signerUuid: string,
  targetHash: string,
): Promise<void> {
  if (!HASH_RE.test(targetHash)) throw new TypeError("Invalid cast hash")
  await neynarWrite(fetcher, requireApiKey(apiKey), "/v2/farcaster/reaction", {
    signer_uuid: requireSignerUuid(signerUuid),
    reaction_type: "like",
    target: targetHash,
  })
}

export async function followUser(
  fetcher: FetchLike,
  apiKey: string,
  signerUuid: string,
  targetFid: number,
): Promise<void> {
  if (!Number.isInteger(targetFid) || targetFid < 1) throw new TypeError("Invalid target fid")
  await neynarWrite(fetcher, requireApiKey(apiKey), "/v2/farcaster/user/follow", {
    signer_uuid: requireSignerUuid(signerUuid),
    target_fids: [targetFid],
  })
}

export async function unfollowUser(
  fetcher: FetchLike,
  apiKey: string,
  signerUuid: string,
  targetFid: number,
): Promise<void> {
  if (!Number.isInteger(targetFid) || targetFid < 1) throw new TypeError("Invalid target fid")
  await neynarWrite(
    fetcher,
    requireApiKey(apiKey),
    "/v2/farcaster/user/follow",
    {
      signer_uuid: requireSignerUuid(signerUuid),
      target_fids: [targetFid],
    },
    "DELETE",
  )
}

export type FcEngagementDriver = Readonly<{
  like: (hash: string) => Promise<void>
}>

export type FcEngagementExecutionResult = Readonly<{
  receipts: readonly FcEngagementReceipt[]
  verifiedActionIds: readonly `sha256:${string}`[]
  ambiguousActionIds: readonly `sha256:${string}`[]
}>

export function buildFcEngagementReceipt(args: Readonly<{
  actionId: `sha256:${string}`
  action: "like"
  target: string
  attemptedAt: string
  verified: boolean
  ambiguous: boolean
  error?: string
}>): FcEngagementReceipt {
  return {
    schema: 1,
    receiptId: sha256Json({
      actionId: args.actionId,
      attemptedAt: args.attemptedAt,
      verified: args.verified,
    }),
    actionId: args.actionId,
    action: args.action,
    target: args.target,
    attemptedAt: args.attemptedAt,
    verified: args.verified,
    ambiguous: args.ambiguous,
    ...(args.error ? { error: args.error.slice(0, 500) } : {}),
  }
}

export async function executeFcEngagementActions(args: Readonly<{
  accepted: readonly FcEngagementDecision[]
  nowIso: string
  apiKey: string
  signerUuid: string
  fetcher?: FetchLike
  driver?: FcEngagementDriver
}>): Promise<FcEngagementExecutionResult> {
  const fetcher = args.fetcher ?? fetch
  const driver = args.driver ?? {
    like: (hash: string) => publishLike(fetcher, args.apiKey, args.signerUuid, hash),
  }

  const receipts: FcEngagementReceipt[] = []
  const verifiedActionIds: `sha256:${string}`[] = []
  const ambiguousActionIds: `sha256:${string}`[] = []

  for (const decision of args.accepted) {
    if (!decision.accepted || decision.action !== "like") continue
    try {
      await driver.like(decision.target)
      const receipt = buildFcEngagementReceipt({
        actionId: decision.actionId as `sha256:${string}`,
        action: "like",
        target: decision.target,
        attemptedAt: args.nowIso,
        verified: true,
        ambiguous: false,
      })
      receipts.push(receipt)
      verifiedActionIds.push(decision.actionId as `sha256:${string}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const receipt = buildFcEngagementReceipt({
        actionId: decision.actionId as `sha256:${string}`,
        action: "like",
        target: decision.target,
        attemptedAt: args.nowIso,
        verified: false,
        ambiguous: true,
        error: message,
      })
      receipts.push(receipt)
      ambiguousActionIds.push(decision.actionId as `sha256:${string}`)
    }
  }

  return { receipts, verifiedActionIds, ambiguousActionIds }
}
