import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFileFsync } from "../lib/fs-atomic.js"
import type { ChainIntegrationLayout } from "./paths.js"
import {
  ChainIntegrationsFileSchema,
  type ChainIntegrationRecord,
  type ChainIntegrationsFile,
} from "./schemas.js"

const MAX_FILE_BYTES = 2_000_000

function ensureRoot(layout: ChainIntegrationLayout): void {
  mkdirSync(layout.root, { recursive: true, mode: 0o700 })
  mkdirSync(layout.artifacts, { recursive: true, mode: 0o700 })
  mkdirSync(layout.journal, { recursive: true, mode: 0o700 })
}

function quarantine(layout: ChainIntegrationLayout, name: string, raw: string): never {
  ensureRoot(layout)
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-")
  const dest = join(layout.root, `${name}.quarantine.${stamp}.json`)
  writeFileSync(dest, raw, { mode: 0o600 })
  throw new Error(`chain-integration state quarantined: ${name}`)
}

export function emptyIntegrationsFile(): ChainIntegrationsFile {
  return {
    schema: 1,
    integrations: [],
    attemptsByDay: {},
    activeIntegrationId: null,
  }
}

export type ChainIntegrationStore = Readonly<{
  layout: ChainIntegrationLayout
  load(): ChainIntegrationsFile
  save(file: ChainIntegrationsFile): Promise<void>
  findBySlug(slug: string, activeOnly?: boolean): ChainIntegrationRecord | undefined
  findById(id: string): ChainIntegrationRecord | undefined
}>

export function createChainIntegrationStore(
  layout: ChainIntegrationLayout,
): ChainIntegrationStore {
  return {
    layout,
    load() {
      ensureRoot(layout)
      if (!existsSync(layout.index)) return emptyIntegrationsFile()
      let raw = ""
      try {
        raw = readFileSync(layout.index, "utf8")
        if (raw.length > MAX_FILE_BYTES) throw new Error("too large")
        return ChainIntegrationsFileSchema.parse(JSON.parse(raw))
      } catch (error) {
        if (raw) quarantine(layout, "index", raw)
        throw error
      }
    },
    async save(file) {
      ensureRoot(layout)
      ChainIntegrationsFileSchema.parse(file)
      await writeAtomicFileFsync(
        layout.index,
        `${JSON.stringify(file, null, 2)}\n`,
        0o600,
      )
    },
    findBySlug(slug, activeOnly = true) {
      const file = this.load()
      return file.integrations.find((i) => {
        if (i.slug !== slug) return false
        if (!activeOnly) return true
        return i.phase !== "completed" && i.phase !== "failed"
      })
    },
    findById(id) {
      return this.load().integrations.find((i) => i.integrationId === id)
    },
  }
}

export async function appendJournalLine(
  layout: ChainIntegrationLayout,
  integrationId: string,
  event: Readonly<Record<string, unknown>>,
): Promise<void> {
  ensureRoot(layout)
  const path = join(layout.journal, `${integrationId}.jsonl`)
  const line = `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`
  const prev = existsSync(path) ? readFileSync(path, "utf8") : ""
  await writeAtomicFileFsync(path, prev + line, 0o600)
}
