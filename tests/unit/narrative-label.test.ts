import { describe, expect, it } from "vitest"
import {
  preferredNarrativeLabel,
  usesStaleRotationFraming,
} from "../../src/lib/narrative-label.js"

const MATURED = {
  slug: "rh-chain-meme-rotation",
  title: "RH Chain agent infra",
  framing: "ecosystem" as const,
}

describe("preferredNarrativeLabel", () => {
  it("prefers mature title over deslug", () => {
    expect(preferredNarrativeLabel(MATURED)).toBe("RH Chain agent infra")
  })

  it("falls back to deslug when immature", () => {
    expect(preferredNarrativeLabel({
      slug: "rh-chain-meme-rotation",
      title: "Robinhood chain meme rotation",
    })).toBe("RH Chain Meme Rotation")
  })

  it("prefers a rotation-free title even before maturity when slug embeds rotation", () => {
    expect(preferredNarrativeLabel({
      slug: "rh-chain-meme-rotation",
      title: "RH Chain agent infra",
    })).toBe("RH Chain agent infra")
  })
})

describe("usesStaleRotationFraming", () => {
  it("flags lane rotation wording against a matured narrative", () => {
    expect(usesStaleRotationFraming("RH rotation still loud on CASHCAT", [MATURED])).toBe(true)
  })

  it("flags mechanical deslug of a matured slug", () => {
    expect(usesStaleRotationFraming(
      "RH Chain Meme Rotation keeps printing catalysts",
      [MATURED],
    )).toBe(true)
  })

  it("allows capital rotating phrasing without lane-rotation framing", () => {
    expect(usesStaleRotationFraming(
      "capital rotating into RH infra while agents ship",
      [MATURED],
    )).toBe(false)
  })

  it("is silent when framing is still rotation", () => {
    expect(usesStaleRotationFraming("RH rotation still loud", [{
      slug: "rh-chain-meme-rotation",
      title: "Robinhood chain meme rotation",
      framing: "rotation",
    }])).toBe(false)
  })
})
