import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  applyDropAction,
  applyTrackAction,
  countActiveForUser,
  planExpiryNotices,
  activeMatchableRequests,
  type TrackingConfigSlice,
} from "../../src/discord/tracking-state.js"
import { emptyTrackingFile } from "../../src/discord/store.js"
import { parseTrackingMatchOutput } from "../../src/discord/tracking-match.js"
import { parseTrackingIntentOutput } from "../../src/discord/tracking-intent.js"
import { sanitizeTrackingReason } from "../../src/discord/tracking-sanitize.js"
import { isExpiredAt, isWithinHours, trackingDeliveryId } from "../../src/discord/tracking-ids.js"
import { createOrGetDelivery } from "../../src/discord/tracking-state.js"
import type { TrackingRequestRecord } from "../../src/discord/schemas.js"

const CFG: TrackingConfigSlice = {
  max_active_per_user: 10,
  ttl_days: 30,
  expiry_bundle_hours: 48,
  pending_capacity_ttl_hours: 48,
  tentative_confirm_window_hours: 24,
  expiry_reply_window_days: 7,
  retention_days: 35,
}

const GUILD = "1000000000000000001"
const CHANNEL = "1000000000000000002"
const USER = "1000000000000000004"
const NOW = "2026-07-21T12:00:00.000Z"

describe("discord tracking properties", () => {
  it("prop_inv_d4_active_cap_never_exceeds_ten", () => {
    fc.assert(fc.property(
      fc.array(fc.boolean(), { minLength: 0, maxLength: 40 }),
      (ops) => {
        let file = emptyTrackingFile()
        let msg = 1000000000000001000n
        for (const isTrack of ops) {
          msg += 1n
          if (isTrack) {
            const applied = applyTrackAction({
              file,
              guildId: GUILD,
              channelId: CHANNEL,
              messageId: msg.toString(),
              userId: USER,
              description: `desc ${msg}`,
              shortLabel: `L${msg.toString().slice(-4)}`,
              confidence: "high",
              nowIso: NOW,
              config: CFG,
            })
            if (applied.ok) file = applied.file
          } else {
            const active = file.requests.filter((r) => r.status === "active")
            if (active.length === 0) continue
            const drop = applyDropAction({
              file,
              guildId: GUILD,
              userId: USER,
              trackingIds: [active[0]!.trackingId],
              triggerMessageId: msg.toString(),
              nowIso: NOW,
              config: CFG,
            })
            if (drop.ok) file = drop.file
          }
          expect(countActiveForUser(file, GUILD, USER, NOW)).toBeLessThanOrEqual(10)
        }
      },
    ), { numRuns: 1_000 })
  })

  it("prop_inv_d4_expired_requests_never_match", () => {
    fc.assert(fc.property(
      fc.integer({ min: -100, max: 100 }),
      (hoursOffset) => {
        const expiresAt = new Date(Date.parse(NOW) + hoursOffset * 3_600_000).toISOString()
        const file = {
          ...emptyTrackingFile(),
          requests: [{
            trackingId: "trk-abcdef12",
            guildId: GUILD,
            channelId: CHANNEL,
            messageId: "1000000000000000003",
            userId: USER,
            description: "x",
            shortLabel: "X",
            status: "active" as const,
            createdAt: NOW,
            updatedAt: NOW,
            expiresAt,
            extensionCount: 0,
            matchedSubjects: [],
          }],
        }
        const matchable = activeMatchableRequests(file, NOW)
        if (isExpiredAt(expiresAt, NOW)) {
          expect(matchable).toHaveLength(0)
        } else {
          expect(matchable).toHaveLength(1)
        }
      },
    ), { numRuns: 200 })
  })

  it("prop_inv_d5_model_output_is_authority_bounded", () => {
    fc.assert(fc.property(fc.string(), (raw) => {
      const intent = parseTrackingIntentOutput(raw)
      if (intent) {
        expect(["track", "drop", "extend", "decline-extend", "none"]).toContain(intent.action)
      }
      const hits = parseTrackingMatchOutput(raw, new Set(["trk-abcdef12"]), 5)
      for (const hit of hits) {
        expect(hit.trackingId).toBe("trk-abcdef12")
        expect(hit.reason).not.toMatch(/<@/u)
        expect(hit.reason).not.toMatch(/https?:\/\//iu)
      }
      const cleaned = sanitizeTrackingReason(raw)
      expect(cleaned).not.toMatch(/<@!?&\d/u)
      expect(cleaned).not.toMatch(/@(?:everyone|here)/iu)
    }), { numRuns: 1_000 })
  })

  it("prop_inv_d3_host_transitions_preserve_schema_and_ownership", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        otherUser: fc.boolean(),
        drop: fc.boolean(),
      }), { minLength: 1, maxLength: 20 }),
      (ops) => {
        let file = emptyTrackingFile()
        let msg = 1000000000000002000n
        for (const op of ops) {
          msg += 1n
          const userId = op.otherUser ? "1000000000000000999" : USER
          const applied = applyTrackAction({
            file,
            guildId: GUILD,
            channelId: CHANNEL,
            messageId: msg.toString(),
            userId,
            description: "desc",
            shortLabel: "Lab",
            confidence: "high",
            nowIso: NOW,
            config: CFG,
          })
          if (applied.ok) file = applied.file
          if (op.drop) {
            const mine = file.requests.filter((r) => r.userId === USER && r.status === "active")
            if (mine[0]) {
              const drop = applyDropAction({
                file,
                guildId: GUILD,
                userId: USER,
                trackingIds: [mine[0].trackingId],
                triggerMessageId: (msg + 1000n).toString(),
                nowIso: NOW,
                config: CFG,
              })
              if (drop.ok) file = drop.file
            }
          }
        }
        for (const r of file.requests) {
          if (r.userId === USER) expect(r.guildId).toBe(GUILD)
        }
        expect(countActiveForUser(file, GUILD, USER, NOW)).toBeLessThanOrEqual(10)
      },
    ), { numRuns: 200 })
  })

  it("prop_inv_d6_delivery_key_is_idempotent", () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 40 }), (subject) => {
      const request: TrackingRequestRecord = {
        trackingId: "trk-abcdef12",
        guildId: GUILD,
        channelId: CHANNEL,
        messageId: "1000000000000000003",
        userId: USER,
        description: "x",
        shortLabel: "X",
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
        expiresAt: "2026-08-20T12:00:00.000Z",
        extensionCount: 0,
        matchedSubjects: [],
      }
      const first = createOrGetDelivery({
        file: { ...emptyTrackingFile(), requests: [request] },
        trackingId: request.trackingId,
        subject,
        reason: "hit",
        batchId: "a".repeat(32),
        sourceKind: "list-scan",
        nowIso: NOW,
        request,
        needsResearch: true,
      })
      const second = createOrGetDelivery({
        file: first.file,
        trackingId: request.trackingId,
        subject,
        reason: "hit again",
        batchId: "b".repeat(32),
        sourceKind: "list-scan",
        nowIso: NOW,
        request: first.file.requests[0]!,
        needsResearch: true,
      })
      expect(second.created).toBe(false)
      expect(first.delivery.deliveryId).toBe(second.delivery.deliveryId)
      expect(first.delivery.deliveryId).toBe(
        trackingDeliveryId(request.trackingId, first.delivery.normalizedSubject),
      )
      expect(first.file.trackingDeliveries).toHaveLength(1)
    }), { numRuns: 200 })
  })

  it("prop_inv_d7_expiry_bundle_is_complete_and_nonduplicating", () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: -72, max: 96 }), { minLength: 1, maxLength: 8 }),
      (offsets) => {
        const requests = offsets.map((hours, i) => ({
          trackingId: `trk-${String(i).padStart(8, "0")}`,
          guildId: GUILD,
          channelId: CHANNEL,
          messageId: `100000000000000${String(i).padStart(4, "0")}`,
          userId: USER,
          description: `d${i}`,
          shortLabel: `L${i}`,
          status: "active" as const,
          createdAt: NOW,
          updatedAt: NOW,
          expiresAt: new Date(Date.parse(NOW) + hours * 3_600_000).toISOString(),
          extensionCount: 0,
          matchedSubjects: [],
        }))
        const file = { ...emptyTrackingFile(), requests }
        const plans = planExpiryNotices({ file, nowIso: NOW, config: CFG })
        const hasElapsed = requests.some((r) => isExpiredAt(r.expiresAt, NOW))
        if (!hasElapsed) {
          expect(plans).toHaveLength(0)
          return
        }
        expect(plans).toHaveLength(1)
        const plan = plans[0]!
        for (const id of plan.bundledIds) {
          const r = requests.find((x) => x.trackingId === id)!
          expect(
            isExpiredAt(r.expiresAt, NOW)
            || isWithinHours(r.expiresAt, NOW, 48),
          ).toBe(true)
        }
        expect(new Set(plan.bundledIds).size).toBe(plan.bundledIds.length)
      },
    ), { numRuns: 500 })
  })
})
