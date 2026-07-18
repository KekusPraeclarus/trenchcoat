import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  getAddress,
  http,
  bytesToHex,
  hexToBytes,
  type Hex,
  type Address,
  type Account,
} from "viem"
import { mnemonicToAccount, generateMnemonic, english } from "viem/accounts"
import { optimism } from "viem/chains"
import { writeAtomicFile } from "../../lib/fs-atomic.js"
import { gatedFetch, readJsonBody } from "../../lib/http.js"
import type { FetchLike } from "../market/geckoterminal.js"
import { NEYNAR_HOST, NEYNAR_ROOT } from "./neynar.js"
import { getSignerStatus } from "./engagement.js"

export type FarcasterSignerProbeStatus =
  | "approved"
  | "pending"
  | "rejected"
  | "unavailable"

export type FarcasterSignerProbe = Readonly<{
  status: FarcasterSignerProbeStatus
  probedAt: string
  signerUuid?: string
  fid?: number
  reason?: string
}>

export type FarcasterSignerGateReceipt = Readonly<{
  schema: 1
  probedAt: string
  status: FarcasterSignerProbeStatus
  signerUuid?: string
  fid?: number
  reason?: string
  mutationsAllowed: boolean
}>

function normalizeProbeStatus(raw: string): FarcasterSignerProbeStatus {
  const status = raw.toLowerCase()
  if (status === "approved") return "approved"
  if (status === "pending_approval" || status === "pending") return "pending"
  if (status === "revoked" || status === "rejected") return "rejected"
  return "unavailable"
}

export function buildSignerGateReceipt(probe: FarcasterSignerProbe): FarcasterSignerGateReceipt {
  return {
    schema: 1,
    probedAt: probe.probedAt,
    status: probe.status,
    ...(probe.signerUuid ? { signerUuid: probe.signerUuid } : {}),
    ...(probe.fid !== undefined ? { fid: probe.fid } : {}),
    ...(probe.reason ? { reason: probe.reason } : {}),
    mutationsAllowed: probe.status === "approved",
  }
}

export async function probeFarcasterSigner(args: Readonly<{
  apiKey: string
  fetcher?: FetchLike
  nowIso?: string
  signerFile?: FarcasterSignerFile
}>): Promise<FarcasterSignerProbe> {
  const probedAt = args.nowIso ?? new Date().toISOString()
  const fetcher = args.fetcher ?? fetch
  if (!existsSync(farcasterSignerPath())) {
    return {
      status: "unavailable",
      probedAt,
      reason: "signer_file_missing",
    }
  }

  let signer: FarcasterSignerFile
  try {
    signer = args.signerFile ?? assertFarcasterSignerReady()
  } catch (error) {
    return {
      status: "unavailable",
      probedAt,
      reason: error instanceof Error ? error.message : "signer_file_invalid",
    }
  }

  try {
    const current = await getSignerStatus(fetcher, args.apiKey, signer.signerUuid)
    const status = normalizeProbeStatus(current.status)
    return {
      status,
      probedAt,
      signerUuid: signer.signerUuid,
      fid: current.fid ?? signer.fid,
      ...(status === "approved" ? {} : { reason: `signer_status=${current.status}` }),
    }
  } catch (error) {
    return {
      status: "unavailable",
      probedAt,
      signerUuid: signer.signerUuid,
      fid: signer.fid,
      reason: error instanceof Error ? error.message : "signer_probe_failed",
    }
  }
}

export function signerMutationsAllowed(probe: FarcasterSignerProbe): boolean {
  return probe.status === "approved"
}


const RATE = { capacity: 30, refillPerSecond: 0.5 } as const

// Optimism Farcaster contracts (@farcaster/core) — checksum via getAddress
const ID_REGISTRY_ADDRESS: Address = getAddress(
  "0x00000000Fc6c5F01Fc30151999387Bb99A9f489b",
)
const SIGNED_KEY_REQUEST_VALIDATOR: Address = getAddress(
  "0x00000000FC700472606ED4fA22623Acf62c60553",
)
const KEY_GATEWAY_ADDRESS: Address = getAddress(
  "0x00000000fC56947c7E7183f8Ca4B62398CaAdf0B",
)

/** Ed25519 key + SignedKeyRequest metadata (Farcaster KeyRegistry types) */
const KEY_TYPE_ED25519 = 1
const METADATA_TYPE_SIGNED_KEY_REQUEST = 1
const MIN_ONCHAIN_WEI = 50_000_000_000_000n // 0.00005 ETH — KeyGateway.add gas headroom on OP

const ID_REGISTRY_ABI = [
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const

const KEY_GATEWAY_ABI = [
  {
    type: "function",
    name: "add",
    stateMutability: "nonpayable",
    inputs: [
      { name: "keyType", type: "uint32" },
      { name: "key", type: "bytes" },
      { name: "metadataType", type: "uint8" },
      { name: "metadata", type: "bytes" },
    ],
    outputs: [],
  },
] as const

function optimismTransport() {
  const rpc = process.env["OPTIMISM_RPC_URL"]?.trim()
  return http(rpc && rpc.length > 0 ? rpc : undefined)
}

export type FarcasterSignerFile = Readonly<{
  schema: 1
  fid: number
  username: string
  signerUuid: string
  publicKey: string
  custodyAddress: string
  /** Present only when we generated the custody wallet — never leave the host */
  custodyMnemonic?: string
  createdAt: string
}>

export function farcasterProfileDir(): string {
  return join(homedir(), ".trenchcoat", "farcaster")
}

export function farcasterSignerPath(): string {
  return join(farcasterProfileDir(), "signer.json")
}

export function assertFarcasterSignerReady(): FarcasterSignerFile {
  const path = farcasterSignerPath()
  if (!existsSync(path)) {
    throw new Error("No Farcaster signer — run `pnpm dev:cli auth farcaster` first")
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown
  if (raw === null || typeof raw !== "object") throw new TypeError("Invalid signer file")
  const fid = Reflect.get(raw, "fid")
  const signerUuid = Reflect.get(raw, "signerUuid")
  const username = Reflect.get(raw, "username")
  const publicKey = Reflect.get(raw, "publicKey")
  const custodyAddress = Reflect.get(raw, "custodyAddress")
  const custodyMnemonic = Reflect.get(raw, "custodyMnemonic")
  const createdAt = Reflect.get(raw, "createdAt")
  if (
    typeof fid !== "number"
    || !Number.isInteger(fid)
    || fid < 1
    || typeof signerUuid !== "string"
    || typeof username !== "string"
    || typeof publicKey !== "string"
    || typeof custodyAddress !== "string"
    || typeof createdAt !== "string"
  ) {
    throw new TypeError("Corrupt Farcaster signer file")
  }
  return {
    schema: 1,
    fid,
    username,
    signerUuid,
    publicKey,
    custodyAddress,
    createdAt,
    ...(typeof custodyMnemonic === "string" ? { custodyMnemonic } : {}),
  }
}

async function persistSigner(file: FarcasterSignerFile): Promise<string> {
  const dir = farcasterProfileDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const path = farcasterSignerPath()
  await writeAtomicFile(path, `${JSON.stringify(file, null, 2)}\n`, 0o600)
  return path
}

async function createNeynarSigner(
  fetcher: FetchLike,
  apiKey: string,
): Promise<Readonly<{ signerUuid: string, publicKey: Hex }>> {
  const response = await gatedFetch(
    fetcher,
    new URL("/v2/farcaster/signer", NEYNAR_ROOT),
    {
      host: NEYNAR_HOST,
      ...RATE,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
    },
    { method: "POST", body: "{}" },
  )
  if (!response.ok) throw new Error(`Neynar create signer HTTP ${response.status}`)
  const payload = await readJsonBody(response)
  if (payload === null || typeof payload !== "object") {
    throw new TypeError("Neynar create signer response invalid")
  }
  const signerUuid = Reflect.get(payload, "signer_uuid")
  const publicKey = Reflect.get(payload, "public_key")
  if (typeof signerUuid !== "string" || typeof publicKey !== "string") {
    throw new TypeError("Neynar create signer missing fields")
  }
  if (!/^0x[a-fA-F0-9]{64}$/u.test(publicKey)) {
    throw new TypeError("Neynar create signer returned invalid public_key")
  }
  return { signerUuid, publicKey: publicKey as Hex }
}

async function signSignedKeyRequestMetadata(args: Readonly<{
  mnemonic: string
  requestFid: number
  publicKey: Hex
  deadline: bigint
}>): Promise<Hex> {
  const account = mnemonicToAccount(args.mnemonic)
  const keyBytes = hexToBytes(args.publicKey)
  const signature = await account.signTypedData({
    domain: {
      name: "Farcaster SignedKeyRequestValidator",
      version: "1",
      chainId: 10,
      verifyingContract: SIGNED_KEY_REQUEST_VALIDATOR,
    },
    types: {
      SignedKeyRequest: [
        { name: "requestFid", type: "uint256" },
        { name: "key", type: "bytes" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "SignedKeyRequest",
    message: {
      requestFid: BigInt(args.requestFid),
      key: bytesToHex(keyBytes),
      deadline: args.deadline,
    },
  })
  return encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "address" },
      { type: "bytes" },
      { type: "uint256" },
    ],
    [BigInt(args.requestFid), account.address, signature, args.deadline],
  )
}

async function signIdTransfer(args: Readonly<{
  mnemonic: string
  fid: number
  deadline: bigint
}>): Promise<Readonly<{ custodyAddress: `0x${string}`, signature: Hex }>> {
  const account = mnemonicToAccount(args.mnemonic)
  const client = createPublicClient({
    chain: optimism,
    transport: optimismTransport(),
  })
  const nonce = await client.readContract({
    address: ID_REGISTRY_ADDRESS,
    abi: ID_REGISTRY_ABI,
    functionName: "nonces",
    args: [account.address],
  })
  const signature = await account.signTypedData({
    domain: {
      name: "Farcaster IdRegistry",
      version: "1",
      chainId: 10,
      verifyingContract: ID_REGISTRY_ADDRESS,
    },
    types: {
      Transfer: [
        { name: "fid", type: "uint256" },
        { name: "to", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Transfer",
    message: {
      fid: BigInt(args.fid),
      to: account.address,
      nonce,
      deadline: args.deadline,
    },
  })
  return { custodyAddress: account.address, signature }
}

async function fetchFreshFid(
  fetcher: FetchLike,
  apiKey: string,
  walletId: string,
): Promise<number> {
  const response = await gatedFetch(fetcher, new URL("/v2/farcaster/user/fid", NEYNAR_ROOT), {
    host: NEYNAR_HOST,
    ...RATE,
    headers: {
      accept: "application/json",
      "x-api-key": apiKey,
      "x-wallet-id": walletId,
    },
    timeoutMs: 120_000,
  })
  if (!response.ok) throw new Error(`Neynar fetch FID HTTP ${response.status}`)
  const payload = await readJsonBody(response)
  if (payload === null || typeof payload !== "object") {
    throw new TypeError("Neynar FID response invalid")
  }
  const fid = Reflect.get(payload, "fid")
  if (typeof fid !== "number" || !Number.isInteger(fid) || fid < 1) {
    throw new TypeError("Neynar FID response missing fid")
  }
  return fid
}

const FNAME_RE = /^[a-z0-9][a-z0-9-]{0,15}$/u

/** Create a bot account via Neynar (no in-app approval). Needs NEYNAR_WALLET_ID. */
export async function createFarcasterAccount(args: Readonly<{
  apiKey: string
  walletId: string
  fname: string
  appFid: number
  appMnemonic: string
  fetcher?: FetchLike
  custodyMnemonic?: string
  nowIso?: string
}>): Promise<FarcasterSignerFile> {
  if (!FNAME_RE.test(args.fname)) {
    throw new TypeError("fname must match /^[a-z0-9][a-z0-9-]{0,15}$/")
  }
  const fetcher = args.fetcher ?? fetch
  const custodyMnemonic = args.custodyMnemonic ?? generateMnemonic(english)
  const deadline = BigInt(Math.floor(Date.now() / 1_000) + 3_600)

  const fid = await fetchFreshFid(fetcher, args.apiKey, args.walletId)
  const { custodyAddress, signature } = await signIdTransfer({
    mnemonic: custodyMnemonic,
    fid,
    deadline,
  })
  const signer = await createNeynarSigner(fetcher, args.apiKey)
  const signedKeyMeta = await signSignedKeyRequestMetadata({
    mnemonic: args.appMnemonic,
    requestFid: args.appFid,
    publicKey: signer.publicKey,
    deadline,
  })

  const response = await gatedFetch(
    fetcher,
    new URL("/v2/farcaster/user", NEYNAR_ROOT),
    {
      host: NEYNAR_HOST,
      ...RATE,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": args.apiKey,
        "x-wallet-id": args.walletId,
      },
      timeoutMs: 120_000,
    },
    {
      method: "POST",
      body: JSON.stringify({
        deadline: Number(deadline),
        requested_user_custody_address: custodyAddress,
        fid,
        signature,
        fname: args.fname,
        signer: {
          uuid: signer.signerUuid,
          signed_key_request_metadata_signature: signedKeyMeta,
          app_fid: args.appFid,
          deadline: Number(deadline),
        },
      }),
    },
  )
  if (!response.ok) throw new Error(`Neynar register account HTTP ${response.status}`)
  const payload = await readJsonBody(response)
  if (payload === null || typeof payload !== "object") {
    throw new TypeError("Neynar register response invalid")
  }
  const registeredSigner = Reflect.get(payload, "signer")
  let signerUuid = signer.signerUuid
  if (registeredSigner !== null && typeof registeredSigner === "object") {
    const uuid = Reflect.get(registeredSigner, "signer_uuid")
    if (typeof uuid === "string") signerUuid = uuid
  }

  const file: FarcasterSignerFile = {
    schema: 1,
    fid,
    username: args.fname,
    signerUuid,
    publicKey: signer.publicKey,
    custodyAddress,
    custodyMnemonic,
    createdAt: args.nowIso ?? new Date().toISOString(),
  }
  await persistSigner(file)
  return file
}

/** Attach a Neynar-managed signer to an existing FID using its custody mnemonic. */
export async function attachSignerToExistingAccount(args: Readonly<{
  apiKey: string
  fid: number
  username: string
  custodyMnemonic: string
  fetcher?: FetchLike
  nowIso?: string
  pollMs?: number
  timeoutMs?: number
}>): Promise<FarcasterSignerFile> {
  if (!Number.isInteger(args.fid) || args.fid < 1) throw new TypeError("Invalid fid")
  if (!FNAME_RE.test(args.username)) throw new TypeError("Invalid username")
  const fetcher = args.fetcher ?? fetch
  const account = mnemonicToAccount(args.custodyMnemonic.trim())
  const expectedCustody = await fetchCustodyAddressForFid(fetcher, args.apiKey, args.fid)
  if (
    expectedCustody
    && getAddress(expectedCustody) !== getAddress(account.address)
  ) {
    throw new Error(
      `Mnemonic derives ${account.address} but FID ${args.fid} custody is ${expectedCustody}. `
      + "Use the Farcaster custody recovery phrase for this account, not a connected wallet seed.",
    )
  }

  const deadlineSec = Math.floor(Date.now() / 1_000) + 86_400
  const deadline = BigInt(deadlineSec)
  const signer = await createNeynarSigner(fetcher, args.apiKey)
  const keyBytes = hexToBytes(signer.publicKey)

  const signature = await account.signTypedData({
    domain: {
      name: "Farcaster SignedKeyRequestValidator",
      version: "1",
      chainId: 10,
      verifyingContract: SIGNED_KEY_REQUEST_VALIDATOR,
    },
    types: {
      SignedKeyRequest: [
        { name: "requestFid", type: "uint256" },
        { name: "key", type: "bytes" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "SignedKeyRequest",
    message: {
      requestFid: BigInt(args.fid),
      key: bytesToHex(keyBytes),
      deadline,
    },
  })

  const metadata = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "requestFid", type: "uint256" },
          { name: "requestSigner", type: "address" },
          { name: "signature", type: "bytes" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    [{
      requestFid: BigInt(args.fid),
      requestSigner: account.address,
      signature,
      deadline,
    }],
  )

  const response = await gatedFetch(
    fetcher,
    new URL("/v2/farcaster/signer/signed_key", NEYNAR_ROOT),
    {
      host: NEYNAR_HOST,
      ...RATE,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": args.apiKey,
      },
    },
    {
      method: "POST",
      body: JSON.stringify({
        signer_uuid: signer.signerUuid,
        signature,
        app_fid: args.fid,
        deadline: deadlineSec,
      }),
    },
  )
  if (!response.ok) {
    const detail = await readErrorBody(response)
    throw new Error(`Neynar signed_key HTTP ${response.status}${detail}`)
  }

  const signedPayload = await readJsonBody(response)
  const approvalUrl = signedPayload !== null && typeof signedPayload === "object"
    ? Reflect.get(signedPayload, "signer_approval_url")
      ?? Reflect.get(signedPayload, "approval_url")
    : undefined

  const onchain = await tryOnchainSignerAdd({
    account,
    publicKey: signer.publicKey,
    metadata,
  })
  if (onchain.mode === "submitted") {
    console.error(`Submitted KeyGateway.add on Optimism: ${onchain.hash}`)
  } else if (onchain.mode === "skipped") {
    printMobileApprovalHelp({
      ...(typeof approvalUrl === "string" ? { approvalUrl } : {}),
      custodyAddress: account.address,
      balanceEth: onchain.balanceEth,
      reason: onchain.reason,
    })
  } else {
    printMobileApprovalHelp({
      ...(typeof approvalUrl === "string" ? { approvalUrl } : {}),
      custodyAddress: account.address,
      reason: `on-chain add failed: ${onchain.error}`,
    })
  }

  const pollMs = args.pollMs ?? 2_000
  const timeoutMs = args.timeoutMs ?? (onchain.mode === "submitted" ? 120_000 : 300_000)
  const deadlineMs = Date.now() + timeoutMs
  let status = "pending_approval"
  while (Date.now() < deadlineMs) {
    const current = await getSignerStatus(fetcher, args.apiKey, signer.signerUuid)
    status = current.status
    if (status === "approved") break
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  if (status !== "approved") {
    throw new Error(
      `Signer not approved (status=${status}). `
      + (onchain.mode === "submitted"
        ? "On-chain tx was sent — wait for confirmation then re-run auth, or check the tx on Optimistic Etherscan."
        : "Approve in the Farcaster mobile app (desktop browsers ignore the deeplink), "
          + `or fund ${account.address} with ~0.001 ETH on Optimism and re-run for host-side KeyGateway.add.`),
    )
  }

  const file: FarcasterSignerFile = {
    schema: 1,
    fid: args.fid,
    username: args.username,
    signerUuid: signer.signerUuid,
    publicKey: signer.publicKey,
    custodyAddress: account.address,
    custodyMnemonic: args.custodyMnemonic.trim(),
    createdAt: args.nowIso ?? new Date().toISOString(),
  }
  await persistSigner(file)
  return file
}

type OnchainAddResult =
  | Readonly<{ mode: "submitted", hash: Hex }>
  | Readonly<{ mode: "skipped", reason: string, balanceEth: string }>
  | Readonly<{ mode: "failed", error: string }>

async function tryOnchainSignerAdd(args: Readonly<{
  account: Account
  publicKey: Hex
  metadata: Hex
}>): Promise<OnchainAddResult> {
  const publicClient = createPublicClient({
    chain: optimism,
    transport: optimismTransport(),
  })
  const balance = await publicClient.getBalance({ address: args.account.address })
  if (balance < MIN_ONCHAIN_WEI) {
    return {
      mode: "skipped",
      reason: "custody has insufficient OP ETH for KeyGateway.add",
      balanceEth: formatEther(balance),
    }
  }
  try {
    const wallet = createWalletClient({
      account: args.account,
      chain: optimism,
      transport: optimismTransport(),
    })
    const hash = await wallet.writeContract({
      address: KEY_GATEWAY_ADDRESS,
      abi: KEY_GATEWAY_ABI,
      functionName: "add",
      args: [
        KEY_TYPE_ED25519,
        args.publicKey,
        METADATA_TYPE_SIGNED_KEY_REQUEST,
        args.metadata,
      ],
    })
    await publicClient.waitForTransactionReceipt({ hash })
    return { mode: "submitted", hash }
  } catch (err) {
    return {
      mode: "failed",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function printMobileApprovalHelp(args: Readonly<{
  approvalUrl?: string
  custodyAddress: string
  balanceEth?: string
  reason?: string
}>): void {
  const lines = [
    "Neynar signer is pending approval.",
    args.reason ? `Host on-chain path unavailable: ${args.reason}` : undefined,
    args.balanceEth !== undefined
      ? `Custody ${args.custodyAddress} balance: ${args.balanceEth} ETH on Optimism.`
      : `Custody: ${args.custodyAddress}`,
    "",
    "Desktop browsers ignore Farcaster deeplinks (they no-op / stay on a blank tab).",
    "Open the approval link on a phone that has the Farcaster app, or scan it as a QR:",
  ]
  if (args.approvalUrl) {
    lines.push(`  https: ${args.approvalUrl}`)
    const token = new URL(args.approvalUrl).searchParams.get("token")
    if (token) {
      lines.push(`  app:  farcaster://signed-key-request?token=${token}`)
    }
  } else {
    lines.push("  (no approval URL returned — check Farcaster app notifications)")
  }
  lines.push(
    "",
    "No-app alternative: send ~0.001 ETH on Optimism to the custody address, then re-run",
    "auth — the host will call KeyGateway.add itself and skip the mobile tap.",
  )
  console.error(lines.filter((line) => line !== undefined).join("\n"))
}

async function fetchCustodyAddressForFid(
  fetcher: FetchLike,
  apiKey: string,
  fid: number,
): Promise<string | undefined> {
  const url = new URL("/v2/farcaster/user/bulk", NEYNAR_ROOT)
  url.searchParams.set("fids", String(fid))
  const response = await gatedFetch(fetcher, url, {
    host: NEYNAR_HOST,
    ...RATE,
    headers: { accept: "application/json", "x-api-key": apiKey },
  })
  if (!response.ok) return undefined
  const payload = await readJsonBody(response)
  if (payload === null || typeof payload !== "object") return undefined
  const users = Reflect.get(payload, "users")
  if (!Array.isArray(users) || users.length === 0) return undefined
  const user = users[0]
  if (user === null || typeof user !== "object") return undefined
  const custody = Reflect.get(user, "custody_address")
  return typeof custody === "string" ? custody : undefined
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text()
    if (!text.trim()) return ""
    return `: ${text.slice(0, 500)}`
  } catch {
    return ""
  }
}
