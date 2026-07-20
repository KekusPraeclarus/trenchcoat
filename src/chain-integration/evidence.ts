import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { writeAtomicFileFsync, sha256Bytes } from "../lib/fs-atomic.js"
import { gatedFetch } from "../lib/http.js"
import { systemClock } from "../lib/clock.js"
import type { ChainIntegrationLayout } from "./paths.js"
import { integrationArtifactDir } from "./paths.js"

export type EvidenceSnapshot = Readonly<{
  name: string
  url: string
  path: string
  hash: `sha256:${string}`
  trust: "untrusted-external"
  fetchedAt: string
  ok: boolean
  status?: number
}>

async function saveSnapshot(
  dir: string,
  name: string,
  url: string,
  body: string,
  ok: boolean,
  status?: number,
): Promise<EvidenceSnapshot> {
  const path = join(dir, `${name}.json`)
  const payload = {
    schema: 1,
    trust: "untrusted-external" as const,
    url,
    fetchedAt: systemClock.nowIso(),
    ok,
    status,
    body: body.slice(0, 200_000),
  }
  const text = `${JSON.stringify(payload, null, 2)}\n`
  await writeAtomicFileFsync(path, text, 0o600)
  return {
    name,
    url,
    path,
    hash: sha256Bytes(Buffer.from(text)),
    trust: "untrusted-external",
    fetchedAt: payload.fetchedAt,
    ok,
    ...(status != null ? { status } : {}),
  }
}

async function fetchText(
  fetcher: typeof fetch,
  url: string,
  host: string,
): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const response = await gatedFetch(fetcher, new URL(url), {
      host,
      capacity: 10,
      refillPerSecond: 10 / 60,
    })
    const text = await response.text()
    return { ok: response.ok, status: response.status, text }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: error instanceof Error ? error.message : "fetch failed",
    }
  }
}

export async function collectChainEvidence(args: Readonly<{
  layout: ChainIntegrationLayout
  integrationId: string
  slug: string
  tokenAddress: string
  fetcher?: typeof fetch
}>): Promise<{
  snapshots: EvidenceSnapshot[]
  dexOk: boolean
  geckoOk: boolean
  goplusSupported: boolean
  goplusChainId?: string
  samplePair?: { chainId: string; pairAddress: string; symbol: string }
}> {
  const fetcher = args.fetcher ?? fetch
  const dir = integrationArtifactDir(args.layout, args.integrationId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const evidenceDir = join(dir, "evidence")
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })

  const snapshots: EvidenceSnapshot[] = []

  const dexSearchUrl =
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(args.tokenAddress)}`
  const dex = await fetchText(fetcher, dexSearchUrl, "api.dexscreener.com")
  snapshots.push(await saveSnapshot(
    evidenceDir,
    "dexscreener-search",
    dexSearchUrl,
    dex.text,
    dex.ok,
    dex.status,
  ))

  let dexOk = false
  let samplePair: { chainId: string; pairAddress: string; symbol: string } | undefined
  if (dex.ok) {
    try {
      const parsed = JSON.parse(dex.text) as {
        pairs?: Array<{
          chainId?: string
          pairAddress?: string
          baseToken?: { address?: string; symbol?: string }
        }>
      }
      const hit = (parsed.pairs ?? []).find(
        (p) => p.baseToken?.address?.toLowerCase() === args.tokenAddress.toLowerCase()
          && typeof p.chainId === "string"
          && typeof p.pairAddress === "string",
      )
      if (hit?.chainId && hit.pairAddress) {
        dexOk = true
        samplePair = {
          chainId: hit.chainId,
          pairAddress: hit.pairAddress,
          symbol: hit.baseToken?.symbol ?? "UNKNOWN",
        }
      }
    } catch {
      dexOk = false
    }
  }

  // Probe gecko networks list (bounded) + optional pool search
  const geckoNetUrl = "https://api.geckoterminal.com/api/v2/networks?page=1"
  const gecko = await fetchText(fetcher, geckoNetUrl, "api.geckoterminal.com")
  snapshots.push(await saveSnapshot(
    evidenceDir,
    "geckoterminal-networks",
    geckoNetUrl,
    gecko.text,
    gecko.ok,
    gecko.status,
  ))
  let geckoOk = gecko.ok
  if (samplePair) {
    const poolUrl =
      `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(samplePair.chainId)}/tokens/${encodeURIComponent(args.tokenAddress)}/pools`
    const pools = await fetchText(fetcher, poolUrl, "api.geckoterminal.com")
    snapshots.push(await saveSnapshot(
      evidenceDir,
      "geckoterminal-token-pools",
      poolUrl,
      pools.text,
      pools.ok,
      pools.status,
    ))
    geckoOk = geckoOk || pools.ok
  }

  const goplusUrl = "https://api.gopluslabs.io/api/v1/supported_chains"
  const goplus = await fetchText(fetcher, goplusUrl, "api.gopluslabs.io")
  snapshots.push(await saveSnapshot(
    evidenceDir,
    "goplus-supported-chains",
    goplusUrl,
    goplus.text,
    goplus.ok,
    goplus.status,
  ))

  let goplusSupported = false
  let goplusChainId: string | undefined
  if (goplus.ok) {
    try {
      const parsed = JSON.parse(goplus.text) as {
        result?: Array<{ id?: string; name?: string }>
      }
      const needle = args.slug.toLowerCase()
      const match = (parsed.result ?? []).find((c) => {
        const name = (c.name ?? "").toLowerCase()
        const id = String(c.id ?? "")
        return name.includes(needle) || name.replace(/\s+/gu, "") === needle
          || (samplePair && id === samplePair.chainId)
      })
      if (match?.id) {
        goplusSupported = true
        goplusChainId = String(match.id)
        const tokUrl =
          `https://api.gopluslabs.io/api/v1/token_security/${goplusChainId}?contract_addresses=${encodeURIComponent(args.tokenAddress)}`
        const tok = await fetchText(fetcher, tokUrl, "api.gopluslabs.io")
        snapshots.push(await saveSnapshot(
          evidenceDir,
          "goplus-token-security",
          tokUrl,
          tok.text,
          tok.ok,
          tok.status,
        ))
      }
    } catch {
      goplusSupported = false
    }
  }

  const indexPath = join(evidenceDir, "index.json")
  await writeAtomicFileFsync(
    indexPath,
    `${JSON.stringify({
      schema: 1,
      slug: args.slug,
      tokenAddress: args.tokenAddress,
      snapshots: snapshots.map((s) => ({
        name: s.name,
        url: s.url,
        path: s.path,
        hash: s.hash,
        ok: s.ok,
      })),
      dexOk,
      geckoOk,
      goplusSupported,
      goplusChainId,
      samplePair,
    }, null, 2)}\n`,
    0o600,
  )

  return {
    snapshots,
    dexOk,
    geckoOk,
    goplusSupported,
    ...(goplusChainId ? { goplusChainId } : {}),
    ...(samplePair ? { samplePair } : {}),
  }
}
