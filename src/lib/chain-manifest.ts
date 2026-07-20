import { z } from "zod"

export const ChainCapabilitiesSchema = z.object({
  research: z.boolean(),
  discordWatch: z.boolean(),
  mainTrack: z.boolean(),
  geckoBars: z.boolean(),
  narrativeDiscovery: z.boolean(),
  walletTracking: z.boolean(),
})

export const ChainManifestSecuritySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goplus"), chainId: z.string().min(1).max(32) }),
  z.object({ kind: z.literal("rugcheck") }),
])

export const ChainManifestSchema = z.object({
  schema: z.literal(1),
  slug: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/u),
  display: z.string().min(1).max(64),
  family: z.enum(["evm", "solana", "other"]),
  aliases: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u)).max(16).default([]),
  geckoterminalNetwork: z.string().min(1).max(64),
  dexscreenerChainId: z.string().min(1).max(64),
  securityScanner: ChainManifestSecuritySchema.optional(),
  nativeBenchmark: z.string().min(3).max(64),
  addressFormat: z.enum(["evm", "base58-32"]),
  walletTracking: z.enum(["helius", "infura", "robinhood-public", "unsupported"]),
  evmChainId: z.number().int().positive().optional(),
  capabilities: ChainCapabilitiesSchema,
}).superRefine((m, ctx) => {
  if (m.capabilities.mainTrack && !m.securityScanner) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "mainTrack requires securityScanner",
      path: ["capabilities", "mainTrack"],
    })
  }
  if (m.capabilities.walletTracking && m.walletTracking === "unsupported") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "walletTracking capability requires non-unsupported walletTracking",
      path: ["capabilities", "walletTracking"],
    })
  }
  if (m.family === "evm" && m.addressFormat !== "evm") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "evm family requires evm addressFormat",
      path: ["addressFormat"],
    })
  }
  if (m.family === "solana" && m.addressFormat !== "base58-32") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "solana family requires base58-32 addressFormat",
      path: ["addressFormat"],
    })
  }
})

export type ChainManifest = z.infer<typeof ChainManifestSchema>
export type ChainCapabilities = z.infer<typeof ChainCapabilitiesSchema>
