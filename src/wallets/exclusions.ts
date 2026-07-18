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
