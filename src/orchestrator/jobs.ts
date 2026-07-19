export type JobName =
  | "watchlist-scan"
  | "list-scan"
  | "farcaster-scan"
  | "narrative-scan"
  | "research"
  | "chart-sweep"
  | "review"
  | "audit"
  | "outcomes-settle"
  | "delivery-retry"
  | "source-list-review"
  | "fc-source-review"
  | "wallet-discovery"
  | "wallet-scan-solana"
  | "wallet-scan-evm"
  | "wallet-review"
  | "fomo-trader-sync"
  | "fomo-signal-scan"
  | "fomo-x-source-review"
  | "fomo-narrative-source-scan"
  | "narrative-source-review"
  | "recover"
  | "harness-improve"

export type PreconditionTier = "host" | "collector" | "none"

export type JobDefinition = Readonly<{
  name: JobName
  skill: string
  description: string
  preconditionTier: PreconditionTier
}>

export const JOBS: ReadonlyArray<JobDefinition> = Object.freeze([
  { name: "watchlist-scan", skill: "watchlist-scan", description: "Scan tracked tokens", preconditionTier: "host" },
  { name: "list-scan", skill: "list-scan", description: "Scan curated social lists", preconditionTier: "none" },
  { name: "farcaster-scan", skill: "farcaster-scan", description: "Scan Farcaster for-you and channels", preconditionTier: "collector" },
  { name: "narrative-scan", skill: "narrative-scan", description: "Narrative lifecycle", preconditionTier: "collector" },
  { name: "research", skill: "research", description: "Research queue drain", preconditionTier: "host" },
  { name: "chart-sweep", skill: "chart-sweep", description: "Chart vision sweep", preconditionTier: "host" },
  { name: "review", skill: "review", description: "Knowledge distillation", preconditionTier: "host" },
  { name: "audit", skill: "review", description: "Sealed audit epoch", preconditionTier: "none" },
  { name: "outcomes-settle", skill: "review", description: "Settle mature source-call and wallet-buy outcomes", preconditionTier: "none" },
  { name: "delivery-retry", skill: "review", description: "Retry staged router ingress without terminal receipt", preconditionTier: "host" },
  { name: "source-list-review", skill: "review", description: "Deterministic X source-list lifecycle", preconditionTier: "none" },
  { name: "fc-source-review", skill: "review", description: "Deterministic Farcaster follow-graph lifecycle", preconditionTier: "none" },
  { name: "wallet-discovery", skill: "wallet-evidence", description: "Early buyer discovery evidence", preconditionTier: "host" },
  { name: "wallet-scan-solana", skill: "wallet-evidence", description: "Solana wallet evidence", preconditionTier: "host" },
  { name: "wallet-scan-evm", skill: "wallet-evidence", description: "EVM wallet evidence", preconditionTier: "host" },
  { name: "wallet-review", skill: "review", description: "Wallet score/lifecycle review", preconditionTier: "none" },
  { name: "fomo-trader-sync", skill: "review", description: "Fomo trader wallet nomination", preconditionTier: "host" },
  { name: "fomo-signal-scan", skill: "review", description: "Fomo feed convergence and pressure signals", preconditionTier: "host" },
  { name: "fomo-x-source-review", skill: "fomo-x-source-review", description: "Classify Fomo-nominated X accounts", preconditionTier: "host" },
  { name: "fomo-narrative-source-scan", skill: "review", description: "Scan probation narrative X sources", preconditionTier: "host" },
  { name: "narrative-source-review", skill: "review", description: "Promote or demote narrative X sources", preconditionTier: "host" },
  { name: "recover", skill: "recover", description: "Recovery assist", preconditionTier: "none" },
  { name: "harness-improve", skill: "review", description: "Propose policy patch PR from sealed audit", preconditionTier: "none" },
])

export function getJob(name: string): JobDefinition {
  const job = JOBS.find((j) => j.name === name)
  if (!job) throw new Error(`Unknown job ${name}`)
  return job
}
