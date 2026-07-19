/**
 * Install FAFO gate results into the host archive (mode 600).
 * Usage: pnpm tsx scripts/install-fomo-gates.ts [path-to-gates.json]
 * Default: ops/fafo-fomo/gates.seed.json
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { FomoGatesFileSchema } from "../src/collectors/fomo/types.js"
import { saveFomoGates } from "../src/collectors/fomo/gates.js"

const src = process.argv[2] ?? join(process.cwd(), "ops", "fafo-fomo", "gates.seed.json")
const archiveRoot = join(homedir(), ".trenchcoat", "archive")
const gates = FomoGatesFileSchema.parse(JSON.parse(readFileSync(src, "utf8")))
await saveFomoGates(archiveRoot, gates)
console.log(JSON.stringify({
  installed: join(archiveRoot, "provider-evaluations", "fomo", "gates.json"),
  provider: gates.gates.provider.verdict,
}, null, 2))
