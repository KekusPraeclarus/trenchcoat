export type JobName =
  | "watchlist-scan"
  | "list-scan"
  | "narrative-scan"
  | "research"
  | "chart-sweep"
  | "review"
  | "audit"
  | "wallet-discovery"
  | "wallet-scan-solana"
  | "wallet-scan-evm"
  | "wallet-review"
  | "recover"

export type JobDefinition = Readonly<{
  name: JobName
  skill: string
  description: string
}>

export const JOBS: ReadonlyArray<JobDefinition> = Object.freeze([
  { name: "watchlist-scan", skill: "watchlist-scan", description: "Scan tracked tokens" },
  { name: "list-scan", skill: "list-scan", description: "Scan curated social lists" },
  { name: "narrative-scan", skill: "narrative-scan", description: "Narrative lifecycle" },
  { name: "research", skill: "research", description: "Research queue drain" },
  { name: "chart-sweep", skill: "chart-sweep", description: "Chart vision sweep" },
  { name: "review", skill: "review", description: "Knowledge distillation" },
  { name: "audit", skill: "review", description: "Sealed audit epoch" },
  { name: "wallet-discovery", skill: "review", description: "Early buyer discovery" },
  { name: "wallet-scan-solana", skill: "review", description: "Helius wallet scan" },
  { name: "wallet-scan-evm", skill: "review", description: "Infura wallet scan" },
  { name: "wallet-review", skill: "review", description: "Wallet score/lifecycle review" },
  { name: "recover", skill: "recover", description: "Recovery assist" },
])

export function getJob(name: string): JobDefinition {
  const job = JOBS.find((j) => j.name === name)
  if (!job) throw new Error(`Unknown job ${name}`)
  return job
}
