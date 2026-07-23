import { describe, expect, it } from "vitest"
import { mkdtempSync, symlinkSync, writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { createRunJournal, advanceRunJournal, RUN_PHASES } from "../../src/orchestrator/journal.js"
import { normalizeEvmAddress, isValidSolanaAddress } from "../../src/lib/address.js"
import { verifyRouterHmac, signRouterRequest, hashBody } from "../../src/lib/router-contract.js"
import { ConfigSchema } from "../../src/lib/config.js"
import { SnapshotEnvelopeSchema } from "../../src/contracts/schemas.js"

const seed = JSON.parse(
  readFileSync(join(process.cwd(), "config/seed.example.json"), "utf8"),
) as unknown

describe("prop_inv_i4_snapshot_path_guard", () => {
  it("rejects path traversal and symlink escape", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-snap-"))
    const writer = new SnapshotWriter(root)
    const envelope = {
      source: "test",
      fetchedAt: new Date().toISOString(),
      trust: "untrusted-external" as const,
      items: [{
        provenance: "p1",
        text: "hello",
        ts: new Date().toISOString(),
        ageSec: 1,
        freshnessTier: "live" as const,
      }],
    }
    await expect(writer.writeInbox("../escape", "x", envelope)).rejects.toThrow()
    const inbox = join(root, "inbox")
    mkdirSync(inbox, { recursive: true })
    const outside = join(root, "outside.txt")
    writeFileSync(outside, "nope")
    const runDir = join(inbox, "run1")
    mkdirSync(runDir)
    symlinkSync(outside, join(runDir, "evil.json"))
    await expect(writer.writeInbox("run1", "evil", envelope)).rejects.toThrow()
  })
})

describe("prop_inv_p1_trust_envelope", () => {
  it("rejects missing or non-literal trust on snapshot envelopes", () => {
    const base = {
      source: "test",
      fetchedAt: new Date().toISOString(),
      items: [{
        provenance: "p1",
        text: "hello",
        ts: new Date().toISOString(),
        ageSec: 1,
        freshnessTier: "live" as const,
      }],
    }
    expect(() => SnapshotEnvelopeSchema.parse(base)).toThrow()
    expect(() => SnapshotEnvelopeSchema.parse({
      ...base,
      trust: "trusted",
    })).toThrow()
    expect(SnapshotEnvelopeSchema.parse({
      ...base,
      trust: "untrusted-external",
    }).trust).toBe("untrusted-external")
  })

  it("SnapshotWriter refuses envelopes without untrusted-external trust", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-trust-"))
    const writer = new SnapshotWriter(root)
    await expect(writer.writeInbox("run1", "bad", {
      source: "test",
      fetchedAt: new Date().toISOString(),
      trust: "trusted" as never,
      items: [{
        provenance: "p1",
        text: "hello",
        ts: new Date().toISOString(),
        ageSec: 1,
        freshnessTier: "live",
      }],
    })).rejects.toThrow()
  })
})

describe("journal phases", () => {
  it("advances through the durable order exactly once", () => {
    let journal = createRunJournal("job-2026-01-01T00-00-00-000Z")
    const hash = `sha256:${"b".repeat(64)}` as const
    for (const phase of RUN_PHASES.slice(1)) {
      journal = advanceRunJournal(journal, phase, hash)
    }
    expect(journal.phase).toBe("complete")
  })
})

describe("addresses", () => {
  it("checksums EVM and validates Solana length", () => {
    const lower = "0x742d35cc6634c0532925a3b844bc454e4438f44e"
    expect(normalizeEvmAddress(lower).startsWith("0x")).toBe(true)
    expect(isValidSolanaAddress("11111111111111111111111111111111")).toBe(true)
    expect(isValidSolanaAddress("nope")).toBe(false)
  })
})

describe("router hmac", () => {
  it("accepts valid signatures and rejects skew", () => {
    const key = "test-hmac-key"
    const body = "{\"ok\":true}"
    const ts = new Date().toISOString()
    const nonce = "nonce-abc-12345"
    const sig = signRouterRequest(key, "POST", "/v1/events", ts, nonce, body)
    expect(verifyRouterHmac({
      hmacKey: key,
      method: "POST",
      path: "/v1/events",
      timestamp: ts,
      nonce,
      body,
      signatureHex: sig,
    }).ok).toBe(true)
    expect(verifyRouterHmac({
      hmacKey: key,
      method: "POST",
      path: "/v1/events",
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      nonce,
      body,
      signatureHex: sig,
      nowMs: Date.now(),
    }).ok).toBe(false)
    expect(hashBody(body).startsWith("sha256:")).toBe(true)
  })
})

describe("config seed", () => {
  it("parses the example seed as schema v18", () => {
    const parsed = ConfigSchema.parse(seed)
    expect(parsed.schema).toBe(18)
    expect(parsed.chat.discord.enabled).toBe(true)
    expect(parsed.twitter.operator_list_urls).toHaveLength(2)
    expect(parsed.twitter.engagement.likes_per_window).toBe(2)
    expect(parsed.harness_improvement.enabled).toBe(true)
    expect(parsed.harness_improvement.push_origin).toBe(true)
    expect(parsed.farcaster.engagement.likes_per_window).toBe(2)
    expect(parsed.fomo.enabled).toBe(false)
    expect(parsed.fomo.shadow_mode).toBe(true)
    expect(parsed.fomo.trader_sync.enabled).toBe(false)
    expect(parsed.fomo.signal_scan.enabled).toBe(false)
  })
})
