import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile } from "./fs-atomic.js"
import {
  LedgerFileSchema,
  ResearchQueueFileSchema,
  SourcesFileSchema,
  SourceLifecycleFileSchema,
  SocialCashtagClusterFileSchema,
  WatchlistFileSchema,
  WalletsFileSchema,
  WalletRunnersFileSchema,
  FomoTraderScoresFileSchema,
  XEngagementFileSchema,
  XBotHealthSchema,
  FcEngagementFileSchema,
  FcSourceLifecycleFileSchema,
  PumpEngagementFileSchema,
  PumpCallerScoresFileSchema,
  PumpBotHealthSchema,
  ScorecardSchema,
  type LedgerFile,
  type ResearchQueueFile,
  type SourcesFile,
  type SourceLifecycleFile,
  type SocialCashtagClusterFile,
  type WatchlistFile,
  type WalletsFile,
  type WalletRunnersFile,
  type FomoTraderScoresFile,
  type XEngagementFile,
  type XBotHealth,
  type FcEngagementFile,
  type FcSourceLifecycleFile,
  type PumpEngagementFile,
  type PumpCallerScoresFile,
  type PumpBotHealth,
  type Scorecard,
} from "../contracts/schemas.js"
import {
  emptyXSourceNominations,
  type XSourceNominationsFile,
} from "../sources/x-nominations.js"
import {
  emptyNarrativeSources,
  type NarrativeSource,
  type NarrativeSourcesFile,
} from "../sources/narrative-lifecycle.js"

function readOrDefault<T>(path: string, parse: (value: unknown) => T, fallback: T): T {
  if (!existsSync(path)) return fallback
  return parse(JSON.parse(readFileSync(path, "utf8")))
}

export class StateStore {
  constructor(private readonly stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  }

  watchlistPath(): string { return join(this.stateDir, "watchlist.json") }
  sourcesPath(): string { return join(this.stateDir, "sources.json") }
  sourceLifecyclePath(): string { return join(this.stateDir, "source-lifecycle.json") }
  fcSourceLifecyclePath(): string { return join(this.stateDir, "fc-source-lifecycle.json") }
  xEngagementPath(): string { return join(this.stateDir, "x-engagement.json") }
  xBotHealthPath(): string { return join(this.stateDir, "x-bot-health.json") }
  fcEngagementPath(): string { return join(this.stateDir, "fc-engagement.json") }
  pumpEngagementPath(): string { return join(this.stateDir, "pump-engagement.json") }
  pumpCallerScoresPath(): string { return join(this.stateDir, "pump-caller-scores.json") }
  pumpBotHealthPath(): string { return join(this.stateDir, "pump-bot-health.json") }
  ledgerPath(): string { return join(this.stateDir, "ledger.json") }
  researchQueuePath(): string { return join(this.stateDir, "research-queue.json") }
  socialCashtagClustersPath(): string { return join(this.stateDir, "social-cashtag-clusters.json") }
  walletsPath(): string { return join(this.stateDir, "wallets.json") }
  walletRunnersPath(): string { return join(this.stateDir, "wallet-runners.json") }
  xSourceNominationsPath(): string { return join(this.stateDir, "x-source-nominations.json") }
  fomoTraderScoresPath(): string { return join(this.stateDir, "fomo-trader-scores.json") }
  xNarrativeSourcesPath(): string { return join(this.stateDir, "x-narrative-sources.json") }
  decisionsPath(): string { return join(this.stateDir, "decisions.md") }
  scorecardPath(): string { return join(this.stateDir, "scorecard.json") }

  loadWatchlist(): WatchlistFile {
    return readOrDefault(
      this.watchlistPath(),
      (v) => WatchlistFileSchema.parse(v),
      { schema: 1, entries: [] },
    )
  }

  async saveWatchlist(file: WatchlistFile): Promise<void> {
    await writeAtomicFile(this.watchlistPath(), `${JSON.stringify(WatchlistFileSchema.parse(file), null, 2)}\n`)
  }

  loadSources(): SourcesFile {
    return readOrDefault(
      this.sourcesPath(),
      (v) => SourcesFileSchema.parse(v),
      { schema: 1, sources: [] },
    )
  }

  async saveSources(file: SourcesFile): Promise<void> {
    await writeAtomicFile(this.sourcesPath(), `${JSON.stringify(SourcesFileSchema.parse(file), null, 2)}\n`)
  }

  loadSourceLifecycle(): SourceLifecycleFile {
    return readOrDefault(
      this.sourceLifecyclePath(),
      (v) => SourceLifecycleFileSchema.parse(v),
      {
        schema: 1,
        candidates: [],
        transitions: [],
        pendingTransitionIds: [],
      },
    )
  }

  async saveSourceLifecycle(file: SourceLifecycleFile): Promise<void> {
    await writeAtomicFile(
      this.sourceLifecyclePath(),
      `${JSON.stringify(SourceLifecycleFileSchema.parse(file), null, 2)}\n`,
    )
  }

  loadFcSourceLifecycle(): FcSourceLifecycleFile {
    return readOrDefault(
      this.fcSourceLifecyclePath(),
      (v) => FcSourceLifecycleFileSchema.parse(v),
      {
        schema: 1,
        candidates: [],
        transitions: [],
        pendingTransitionIds: [],
      },
    )
  }

  async saveFcSourceLifecycle(file: FcSourceLifecycleFile): Promise<void> {
    await writeAtomicFile(
      this.fcSourceLifecyclePath(),
      `${JSON.stringify(FcSourceLifecycleFileSchema.parse(file), null, 2)}\n`,
    )
  }

  loadXEngagement(): XEngagementFile {
    const today = new Date().toISOString().slice(0, 10)
    return readOrDefault(
      this.xEngagementPath(),
      (v) => XEngagementFileSchema.parse(v),
      {
        schema: 1,
        followedHandles: [],
        likedPostIds: [],
        lastLikedAt: {},
        lastFollowedAt: {},
        pendingActionIds: [],
        decisions: [],
        receipts: [],
        daily: { day: today, likes: 0, follows: 0, unfollows: 0 },
      },
    )
  }

  async saveXEngagement(file: XEngagementFile): Promise<void> {
    await writeAtomicFile(
      this.xEngagementPath(),
      `${JSON.stringify(XEngagementFileSchema.parse(file), null, 2)}\n`,
    )
  }

  loadXBotHealth(nowIso?: string): XBotHealth {
    const updatedAt = nowIso ?? new Date().toISOString()
    return readOrDefault(
      this.xBotHealthPath(),
      (v) => XBotHealthSchema.parse(v),
      {
        schema: 1,
        updatedAt,
        consecutiveFailures: 0,
      },
    )
  }

  async saveXBotHealth(file: XBotHealth): Promise<void> {
    await writeAtomicFile(
      this.xBotHealthPath(),
      `${JSON.stringify(XBotHealthSchema.parse(file), null, 2)}\n`,
    )
  }

  loadPumpEngagement(): PumpEngagementFile {
    const today = new Date().toISOString().slice(0, 10)
    return readOrDefault(
      this.pumpEngagementPath(),
      (v) => PumpEngagementFileSchema.parse(v),
      {
        schema: 1,
        followedHandles: [],
        likedItemIds: [],
        lastLikedAt: {},
        lastFollowedAt: {},
        pendingActionIds: [],
        decisions: [],
        receipts: [],
        daily: { day: today, likes: 0, follows: 0, unfollows: 0 },
      },
    )
  }

  async savePumpEngagement(file: PumpEngagementFile): Promise<void> {
    await writeAtomicFile(
      this.pumpEngagementPath(),
      `${JSON.stringify(PumpEngagementFileSchema.parse(file), null, 2)}\n`,
    )
  }

  loadPumpCallerScores(): PumpCallerScoresFile {
    return readOrDefault(
      this.pumpCallerScoresPath(),
      (v) => PumpCallerScoresFileSchema.parse(v),
      { schema: 1, callers: [] },
    )
  }

  async savePumpCallerScores(file: PumpCallerScoresFile): Promise<void> {
    await writeAtomicFile(
      this.pumpCallerScoresPath(),
      `${JSON.stringify(PumpCallerScoresFileSchema.parse(file), null, 2)}\n`,
    )
  }

  loadPumpBotHealth(nowIso?: string): PumpBotHealth {
    const updatedAt = nowIso ?? new Date().toISOString()
    return readOrDefault(
      this.pumpBotHealthPath(),
      (v) => PumpBotHealthSchema.parse(v),
      {
        schema: 1,
        updatedAt,
        consecutiveFailures: 0,
      },
    )
  }

  async savePumpBotHealth(file: PumpBotHealth): Promise<void> {
    await writeAtomicFile(
      this.pumpBotHealthPath(),
      `${JSON.stringify(PumpBotHealthSchema.parse(file), null, 2)}\n`,
    )
  }

  loadFcEngagement(): FcEngagementFile {
    const today = new Date().toISOString().slice(0, 10)
    return readOrDefault(
      this.fcEngagementPath(),
      (v) => FcEngagementFileSchema.parse(v),
      {
        schema: 1,
        likedCastHashes: [],
        lastLikedAt: {},
        pendingActionIds: [],
        decisions: [],
        receipts: [],
        daily: { day: today, likes: 0 },
      },
    )
  }

  async saveFcEngagement(file: FcEngagementFile): Promise<void> {
    await writeAtomicFile(
      this.fcEngagementPath(),
      `${JSON.stringify(FcEngagementFileSchema.parse(file), null, 2)}\n`,
    )
  }

  loadLedger(): LedgerFile {
    return readOrDefault(
      this.ledgerPath(),
      (v) => LedgerFileSchema.parse(v),
      { schema: 1, positions: [] },
    )
  }

  async saveLedger(file: LedgerFile): Promise<void> {
    await writeAtomicFile(this.ledgerPath(), `${JSON.stringify(LedgerFileSchema.parse(file), null, 2)}\n`)
  }

  loadResearchQueue(): ResearchQueueFile {
    return readOrDefault(
      this.researchQueuePath(),
      (v) => ResearchQueueFileSchema.parse(v),
      { schema: 1, entries: [] },
    )
  }

  async saveResearchQueue(file: ResearchQueueFile): Promise<void> {
    await writeAtomicFile(
      this.researchQueuePath(),
      `${JSON.stringify(ResearchQueueFileSchema.parse(file), null, 2)}\n`,
    )
  }

  loadSocialCashtagClusters(): SocialCashtagClusterFile {
    return readOrDefault(
      this.socialCashtagClustersPath(),
      (v) => SocialCashtagClusterFileSchema.parse(v),
      { schema: 1, clusters: [] },
    )
  }

  async saveSocialCashtagClusters(file: SocialCashtagClusterFile): Promise<void> {
    await writeAtomicFile(
      this.socialCashtagClustersPath(),
      `${JSON.stringify(SocialCashtagClusterFileSchema.parse(file), null, 2)}\n`,
    )
  }

  loadWallets(): WalletsFile {
    const parsed = readOrDefault(
      this.walletsPath(),
      (v) => WalletsFileSchema.parse(v),
      {
        schema: 1,
        wallets: [],
        transitions: [],
        pendingTransitionIds: [],
        cursors: [],
        exclusions: [],
      },
    )
    return { ...parsed, exclusions: parsed.exclusions ?? [] }
  }

  async saveWallets(file: WalletsFile): Promise<void> {
    const normalized = WalletsFileSchema.parse({
      ...file,
      exclusions: file.exclusions ?? [],
    })
    await writeAtomicFile(
      this.walletsPath(),
      `${JSON.stringify({ ...normalized, exclusions: normalized.exclusions ?? [] }, null, 2)}\n`,
    )
  }

  loadWalletRunners(): WalletRunnersFile {
    return readOrDefault(
      this.walletRunnersPath(),
      (v) => WalletRunnersFileSchema.parse(v),
      {
        schema: 1,
        pools: [],
        sightings: [],
        cursors: [],
        alertedConvergenceIds: [],
        enqueuedConvergenceIds: [],
        cooldownUntilByToken: {},
      },
    )
  }

  async saveWalletRunners(file: WalletRunnersFile): Promise<void> {
    await writeAtomicFile(
      this.walletRunnersPath(),
      `${JSON.stringify(WalletRunnersFileSchema.parse(file), null, 2)}\n`,
    )
  }

  loadXSourceNominations(): XSourceNominationsFile {
    return readOrDefault(
      this.xSourceNominationsPath(),
      (v) => {
        const raw = v as XSourceNominationsFile
        if (raw?.schema !== 1 || !Array.isArray(raw.nominations)) return emptyXSourceNominations()
        return raw
      },
      emptyXSourceNominations(),
    )
  }

  async saveXSourceNominations(file: XSourceNominationsFile): Promise<void> {
    await writeAtomicFile(this.xSourceNominationsPath(), `${JSON.stringify(file, null, 2)}\n`)
  }

  loadFomoTraderScores(): FomoTraderScoresFile {
    return readOrDefault(
      this.fomoTraderScoresPath(),
      (v) => FomoTraderScoresFileSchema.parse(v),
      { schema: 1, traders: [] },
    )
  }

  async saveFomoTraderScores(file: FomoTraderScoresFile): Promise<void> {
    await writeAtomicFile(
      this.fomoTraderScoresPath(),
      `${JSON.stringify(FomoTraderScoresFileSchema.parse(file), null, 2)}\n`,
    )
  }

  loadXNarrativeSources(): NarrativeSourcesFile {
    return readOrDefault(
      this.xNarrativeSourcesPath(),
      (v) => {
        const raw = v as NarrativeSourcesFile
        if (raw?.schema !== 1 || !Array.isArray(raw.sources)) return emptyNarrativeSources()
        return {
          schema: 1,
          sources: raw.sources.map((item: NarrativeSource) => {
            const slugs = Array.isArray(item.acceptedNarrativeSlugs)
              ? item.acceptedNarrativeSlugs.filter((s: string) => typeof s === "string").slice(0, 64)
              : []
            return {
              ...item,
              acceptedNarrativeSlugs: slugs,
              distinctNarratives: slugs.length > 0 ? slugs.length : Number(item.distinctNarratives) || 0,
            }
          }),
        }
      },
      emptyNarrativeSources(),
    )
  }

  async saveXNarrativeSources(file: NarrativeSourcesFile): Promise<void> {
    await writeAtomicFile(this.xNarrativeSourcesPath(), `${JSON.stringify(file, null, 2)}\n`)
  }

  loadScorecard(): Scorecard | undefined {
    if (!existsSync(this.scorecardPath())) return undefined
    return ScorecardSchema.parse(JSON.parse(readFileSync(this.scorecardPath(), "utf8")))
  }

  async saveScorecard(scorecard: Scorecard): Promise<void> {
    await writeAtomicFile(
      this.scorecardPath(),
      `${JSON.stringify(ScorecardSchema.parse(scorecard), null, 2)}\n`,
    )
  }

  readDecisions(): string {
    if (!existsSync(this.decisionsPath())) return ""
    return readFileSync(this.decisionsPath(), "utf8")
  }

  async appendDecision(entry: string): Promise<void> {
    const prev = this.readDecisions()
    if (prev.length > 0 && !entry.startsWith("\n") && !prev.endsWith("\n")) {
      await writeAtomicFile(this.decisionsPath(), `${prev}\n${entry}`)
      return
    }
    await writeAtomicFile(this.decisionsPath(), `${prev}${entry}`)
  }
}
