import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const root = process.cwd()
const failures: string[] = []

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue
    const path = join(dir, entry)
    const st = statSync(path)
    if (st.isDirectory()) walk(path, out)
    else if (entry.endsWith(".ts") || entry.endsWith(".json") || entry.endsWith(".md")) out.push(path)
  }
  return out
}

const files = walk(root)
const signingBanned = /\b(ethers|viem|@solana\/web3\.js|web3\.js|bitcoinjs|wagmi)\b/
const secretish = /(CURSOR_API_KEY|TELEGRAM_BOT_TOKEN|TRENCHCOAT_ROUTER_TOKEN|PRIVATE_KEY|SECRET_KEY)\s*=\s*['"][^'"]+['"]/

for (const file of files) {
  const rel = relative(root, file)
  const text = readFileSync(file, "utf8")

  if (rel.startsWith("agent/") && secretish.test(text)) {
    failures.push(`${rel}: secret-like assignment under agent/`)
  }

  if (rel.startsWith("src/") && signingBanned.test(text) && !rel.includes("lint-static")) {
    failures.push(`${rel}: banned signing/wallet dependency reference`)
  }

  if (rel.startsWith("src/chat/") && /\bfetch\s*\(/.test(text)) {
    failures.push(`${rel}: raw fetch in chat layer violates INV-R4`)
  }

  if (
    rel.startsWith("src/collectors/")
    && /\bfetch\s*\(/.test(text)
    && !rel.endsWith("http.ts")
    && !rel.includes("/rate-gate")
    && !text.includes("from \"../../lib/http.js\"")
    && !text.includes("from \"../lib/http.js\"")
    && !text.includes("FetchLike")
  ) {
    // collectors may receive FetchLike; only flag direct global fetch usage without gated client
    if (/globalThis\.fetch|\bfetch\(/.test(text) && !text.includes("gatedFetch") && !text.includes("FetchLike")) {
      failures.push(`${rel}: raw fetch outside gated client`)
    }
  }
}

if (failures.length > 0) {
  console.error("Static lint failures:")
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`Static lint passed over ${files.length} files`)
