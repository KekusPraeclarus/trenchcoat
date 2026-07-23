import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseDiscordWalletText } from "../../src/collectors/discord-wallet/parse.js"
import { COLOR_BUY, COLOR_SELL } from "../../src/collectors/discord-wallet/types.js"

const FIXTURES = join(import.meta.dirname, "../fixtures/discord-wallet")

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8")
}

describe("discord-wallet parse", () => {
  it("parses SOL swap buy with Token mint", () => {
    const event = parseDiscordWalletText({
      text: fixture("sol-buy.txt"),
      embedColor: COLOR_BUY,
    })
    expect(event?.parser).toBe("cielo_swap")
    expect(event?.side).toBe("buy")
    expect(event?.tokenContract).toBe("EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA")
    expect(event?.tokenIn).toBe("USDT")
    expect(event?.tokenOut).toBe("SQUIRE")
    expect(event?.amountUsd).toBe("500")
    expect(event?.confidence).toBe("high")
    expect(event?.chain).toBe("solana")
  })

  it("parses ETH swap sell with 0x Token", () => {
    const event = parseDiscordWalletText({
      text: fixture("eth-sell.txt"),
      embedColor: COLOR_SELL,
    })
    expect(event?.parser).toBe("cielo_swap")
    expect(event?.side).toBe("sell")
    expect(event?.tokenContract).toBe("0xe5544a2a5fa9b175da60d8eec67add5582bb31b0")
    expect(event?.tokenIn).toBe("HTK")
    expect(event?.tokenOut).toBe("WETH")
    expect(event?.amountUsd).toBe("728.88")
    expect(event?.confidence).toBe("high")
  })

  it("parses transfer with Token as context-only", () => {
    const event = parseDiscordWalletText({ text: fixture("transfer.txt") })
    expect(event?.parser).toBe("cielo_transfer")
    expect(event?.side).toBe("transfer")
    expect(event?.tokenContract).toBe("9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump")
    expect(event?.confidence).toBe("high")
  })

  it("parses mint", () => {
    const event = parseDiscordWalletText({ text: fixture("mint.txt") })
    expect(event?.parser).toBe("cielo_mint")
    expect(event?.side).toBe("mint")
    expect(event?.tokenContract).toBe("0xb08d8becab1bf76a9ce3d2d5fa946f65ec1d3e83")
  })

  it("parses asset-flow receive without Token as medium confidence", () => {
    const event = parseDiscordWalletText({ text: fixture("asset-flow.txt") })
    expect(event?.parser).toBe("asset_flow")
    expect(event?.side).toBe("receive")
    expect(event?.tokenContract).toBeUndefined()
    expect(event?.confidence).toBe("medium")
    expect(event?.actor).toContain("Erebos991")
    expect(event?.chain).toBe("base")
  })

  it("parses HyperCore POSITION as position", () => {
    const event = parseDiscordWalletText({ text: fixture("hypercore.txt") })
    expect(event?.parser).toBe("hypercore_position")
    expect(event?.side).toBe("position")
    expect(event?.confidence).toBe("high")
  })

  it("parses human buy as low confidence", () => {
    const event = parseDiscordWalletText({
      text: fixture("human.txt"),
      authorUsername: "alice",
    })
    expect(event?.parser).toBe("human_lossy")
    expect(event?.side).toBe("buy")
    expect(event?.confidence).toBe("low")
    expect(event?.actor).toBe("alice")
    expect(event?.tokenContract).toBe("EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA")
  })
})
