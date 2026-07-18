import { mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFile, sha256Bytes } from "./fs-atomic.js"
import {
  RouterEventSchema,
  type RouterEvent,
} from "../contracts/schemas.js"
import { eventPayloadHash } from "./router-contract.js"

function baseComparable(event: RouterEvent): string {
  const { channels: _channels, ...rest } = event
  return eventPayloadHash(rest as RouterEvent)
}

export class Outbox {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  async stage(event: RouterEvent): Promise<{ path: string; hash: `sha256:${string}` }> {
    const parsed = RouterEventSchema.parse(event)
    const hash = eventPayloadHash(parsed)
    const file = join(this.dir, `${parsed.eventId.slice("sha256:".length)}.json`)
    if (existsSync(file)) {
      const existing = RouterEventSchema.parse(JSON.parse(readFileSync(file, "utf8")))
      if (eventPayloadHash(existing) !== hash) {
        throw new Error(`Outbox conflict for ${parsed.eventId}`)
      }
      return { path: file, hash }
    }
    const body = `${JSON.stringify(parsed, null, 2)}\n`
    await writeAtomicFile(file, body)
    return { path: file, hash: sha256Bytes(body) }
  }

  /**
   * Permit adding/replacing `channels` when all base fields (eventId, type, text,
   * refs, auditClaim, …) are unchanged. Used by host channel-render before first POST.
   */
  async enrich(event: RouterEvent): Promise<{ path: string; hash: `sha256:${string}` }> {
    const parsed = RouterEventSchema.parse(event)
    const file = join(this.dir, `${parsed.eventId.slice("sha256:".length)}.json`)
    if (!existsSync(file)) {
      throw new Error(`Outbox enrich missing ${parsed.eventId}`)
    }
    const existing = RouterEventSchema.parse(JSON.parse(readFileSync(file, "utf8")))
    if (existing.eventId !== parsed.eventId) {
      throw new Error(`Outbox enrich eventId mismatch for ${parsed.eventId}`)
    }
    if (baseComparable(existing) !== baseComparable(parsed)) {
      throw new Error(`Outbox enrich base-field conflict for ${parsed.eventId}`)
    }
    if (!parsed.channels) {
      throw new Error(`Outbox enrich requires channels for ${parsed.eventId}`)
    }
    const body = `${JSON.stringify(parsed, null, 2)}\n`
    await writeAtomicFile(file, body)
    return { path: file, hash: sha256Bytes(body) }
  }

  list(): RouterEvent[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => RouterEventSchema.parse(
        JSON.parse(readFileSync(join(this.dir, name), "utf8")),
      ))
  }
}
