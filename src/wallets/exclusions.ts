import type { WalletExclusionEvidence, WalletsFile } from "../contracts/schemas.js"
import { sha256Json } from "../lib/canonical-json.js"
import { HARD_EXCLUSION_REASONS, type HardExclusion } from "./scoring.js"

const KNOWN: ReadonlySet<string> = new Set(HARD_EXCLUSION_REASONS)

export type ExclusionSubject = Readonly<{
  address: string
  kind?: string
  failedTx?: boolean
  finalized?: boolean
  removed?: boolean
  priceable?: boolean
  securityFailed?: boolean
  selfTransfer?: boolean
  wash?: boolean
}>

const ENTITY_KIND_MAP: Readonly<Record<string, HardExclusion>> = {
  contract: "contract",
  program: "program",
  router: "router",
  pool: "pool",
  bridge: "bridge",
  cex: "cex",
  team: "team",
  deployer: "deployer",
}

/** Absolute hard exclusions — LLM votes cannot override. Unknown kinds fail closed as contract. */
export function classifyHardExclusion(subject: ExclusionSubject): HardExclusion | undefined {
  if (subject.failedTx) return "failed-tx"
  if (subject.finalized === false) return "unfinalized"
  if (subject.removed) return "unfinalized"
  if (subject.priceable === false) return "unpriceable"
  if (subject.securityFailed) return "security-failed"
  if (subject.selfTransfer) return "self-transfer"
  if (subject.wash) return "wash"
  if (subject.kind) {
    const mapped = ENTITY_KIND_MAP[subject.kind.toLowerCase()]
    if (mapped) return mapped
    if (KNOWN.has(subject.kind as HardExclusion)) return subject.kind as HardExclusion
    return "contract"
  }
  return undefined
}

export function isZeroAddress(address: string): boolean {
  return /^0x0{40}$/iu.test(address)
}

export function walletIdFor(chain: string, address: string): string {
  return `${chain}:${address}`
}

export function exclusionSubjectsFromEvidence(
  evidence: readonly WalletExclusionEvidence[],
): Map<string, ExclusionSubject> {
  const out = new Map<string, ExclusionSubject>()
  for (const row of evidence) {
    out.set(row.walletId, { address: row.address, kind: row.kind })
  }
  return out
}

export function upsertWalletExclusion(
  file: WalletsFile,
  args: Readonly<{
    chain: WalletExclusionEvidence["chain"]
    address: string
    kind: string
    observedAt: string
    detail?: string
  }>,
): WalletsFile {
  const walletId = walletIdFor(args.chain, args.address)
  const evidenceHash = sha256Json({
    walletId,
    kind: args.kind,
    detail: args.detail ?? "",
  })
  const next: WalletExclusionEvidence = {
    schema: 1,
    walletId,
    address: args.address,
    chain: args.chain,
    kind: args.kind,
    evidenceHash,
    observedAt: args.observedAt,
    ...(args.detail ? { detail: args.detail } : {}),
  }
  const exclusions = [
    ...(file.exclusions ?? []).filter((e) => e.walletId !== walletId),
    next,
  ].slice(-5_000)
  return { ...file, exclusions }
}

/** EOA/native account when bytecode is empty; contract otherwise. Missing code fails closed. */
export function classifyEvmBytecode(codeHex: string | null | undefined): "contract" | "eoa" | "unknown" {
  if (codeHex === undefined || codeHex === null) return "unknown"
  const normalized = codeHex.trim().toLowerCase()
  if (normalized === "" || normalized === "0x" || normalized === "0x0") return "eoa"
  if (!/^0x[0-9a-f]*$/u.test(normalized)) return "unknown"
  return normalized.length > 2 ? "contract" : "eoa"
}

export function classifySolanaAccount(args: Readonly<{
  executable?: boolean
  owner?: string
}>): "program" | "wallet" | "unknown" {
  if (args.executable === undefined) return "unknown"
  if (args.executable) return "program"
  return "wallet"
}

export function sameSlotBuyRatio(
  blocks: readonly number[],
): Readonly<{ ratio: number; sample: number }> {
  if (blocks.length === 0) return { ratio: 0, sample: 0 }
  const counts = new Map<number, number>()
  for (const b of blocks) counts.set(b, (counts.get(b) ?? 0) + 1)
  let max = 0
  for (const n of counts.values()) max = Math.max(max, n)
  return { ratio: max / blocks.length, sample: blocks.length }
}
