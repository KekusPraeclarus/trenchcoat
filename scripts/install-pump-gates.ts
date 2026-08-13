/**
 * Install FAFO gate results into the host archive (mode 600).
 * Usage: pnpm tsx scripts/install-pump-gates.ts [path-to-gates.json]
 * Default: ops/fafo-pump/gates.seed.json
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { PumpGatesFileSchema } from "../src/collectors/pump/types.js"
import { savePumpGates } from "../src/collectors/pump/gates.js"

const src = process.argv[2] ?? join(process.cwd(), "ops", "fafo-pump", "gates.seed.json")
const archiveRoot = join(homedir(), ".trenchcoat", "archive")
const gates = PumpGatesFileSchema.parse(JSON.parse(readFileSync(src, "utf8")))
await savePumpGates(archiveRoot, gates)
console.log(JSON.stringify({
  installed: join(archiveRoot, "provider-evaluations", "pump", "gates.json"),
  provider: gates.gates.provider.verdict,
}, null, 2))
