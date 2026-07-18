import { describe, expect, it, vi } from "vitest"
import {
  buildSignerGateReceipt,
  probeFarcasterSigner,
  signerMutationsAllowed,
} from "../../src/collectors/farcaster/signer.js"

describe("farcaster signer probe", () => {
  it("maps approved signer status to allowed mutations", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      status: "approved",
      fid: 99,
    }), { status: 200, headers: { "content-type": "application/json" } }))
    const probe = await probeFarcasterSigner({
      apiKey: "key",
      fetcher,
      nowIso: "2026-07-18T00:00:00.000Z",
      signerFile: {
        schema: 1,
        fid: 99,
        username: "bot",
        signerUuid: "11111111-1111-4111-8111-111111111111",
        publicKey: "0x1111111111111111111111111111111111111111111111111111111111111111",
        custodyAddress: "0x742d35cc6634c0532925a3b844bc454e4438f44e",
        createdAt: "2026-07-17T00:00:00.000Z",
      },
    })
    expect(probe.status).toBe("approved")
    expect(signerMutationsAllowed(probe)).toBe(true)
    expect(buildSignerGateReceipt(probe).mutationsAllowed).toBe(true)
  })

  it("blocks mutations for pending and rejected signer states", async () => {
    for (const status of ["pending_approval", "revoked"] as const) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ status }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      const probe = await probeFarcasterSigner({
        apiKey: "key",
        fetcher,
        signerFile: {
          schema: 1,
          fid: 1,
          username: "bot",
          signerUuid: "11111111-1111-4111-8111-111111111111",
          publicKey: "0x1111111111111111111111111111111111111111111111111111111111111111",
          custodyAddress: "0x742d35cc6634c0532925a3b844bc454e4438f44e",
          createdAt: "2026-07-17T00:00:00.000Z",
        },
      })
      expect(signerMutationsAllowed(probe)).toBe(false)
      expect(buildSignerGateReceipt(probe).mutationsAllowed).toBe(false)
    }
  })
})
