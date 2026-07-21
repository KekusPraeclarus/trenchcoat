import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fastForwardLocalMain,
  IntegrateError,
} from "../../src/harness/integrate.js"

function git(cwd: string, args: readonly string[]): string {
  const out = spawnSync("git", [...args], { cwd, encoding: "utf8" })
  if ((out.status ?? 1) !== 0) {
    throw new Error(`${args.join(" ")}: ${out.stderr || out.stdout}`)
  }
  return (out.stdout ?? "").trim()
}

function initRepoPair(): {
  home: string
  repoRoot: string
  remote: string
  baseSha: string
  branch: string
  candidateSha: string
} {
  const root = mkdtempSync(join(tmpdir(), "tc-hi-integrate-"))
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  const remote = join(root, "remote.git")
  const repoRoot = join(root, "repo")
  git(root, ["init", "--bare", remote])
  git(root, ["clone", remote, repoRoot])
  git(repoRoot, ["checkout", "-b", "main"])
  git(repoRoot, ["config", "user.email", "harness@test"])
  git(repoRoot, ["config", "user.name", "harness"])
  mkdirSync(join(repoRoot, "agent", "skills", "decision-policy"), { recursive: true })
  writeFileSync(
    join(repoRoot, "agent", "skills", "decision-policy", "policy.json"),
    `${JSON.stringify({ schema: 1, version: "base" }, null, 2)}\n`,
  )
  git(repoRoot, ["add", "-A"])
  git(repoRoot, ["commit", "-m", "base"])
  const baseSha = git(repoRoot, ["rev-parse", "HEAD"])
  git(repoRoot, ["push", "-u", "origin", "main"])

  const branch = "harness/test-hyp"
  git(repoRoot, ["checkout", "-b", branch])
  writeFileSync(
    join(repoRoot, "agent", "skills", "decision-policy", "policy.json"),
    `${JSON.stringify({ schema: 1, version: "candidate" }, null, 2)}\n`,
  )
  git(repoRoot, ["add", "-A"])
  git(repoRoot, ["commit", "-m", "candidate"])
  const candidateSha = git(repoRoot, ["rev-parse", "HEAD"])
  git(repoRoot, ["checkout", "main"])
  return { home, repoRoot, remote, baseSha, branch, candidateSha }
}

describe("harness integrate push", () => {
  it("pushes candidate to origin/main then ff local main", () => {
    const { home, repoRoot, baseSha, branch, candidateSha } = initRepoPair()
    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    try {
      const head = fastForwardLocalMain({
        repoRoot,
        baseSha,
        branch,
        candidateSha,
        pushOrigin: true,
      })
      expect(head).toBe(candidateSha)
      expect(git(repoRoot, ["rev-parse", "HEAD"])).toBe(candidateSha)
      expect(git(repoRoot, ["rev-parse", "origin/main"])).toBe(candidateSha)
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
    }
  })

  it("leaves origin untouched when pushOrigin is false", () => {
    const { home, repoRoot, baseSha, branch, candidateSha } = initRepoPair()
    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    try {
      fastForwardLocalMain({
        repoRoot,
        baseSha,
        branch,
        candidateSha,
        pushOrigin: false,
      })
      expect(git(repoRoot, ["rev-parse", "HEAD"])).toBe(candidateSha)
      expect(git(repoRoot, ["rev-parse", "origin/main"])).toBe(baseSha)
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
    }
  })

  it("aborts push when origin/main moved", () => {
    const { home, repoRoot, remote, baseSha, branch, candidateSha } = initRepoPair()
    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    try {
      const other = join(home, "other")
      git(home, ["clone", remote, other])
      git(other, ["config", "user.email", "other@test"])
      git(other, ["config", "user.name", "other"])
      writeFileSync(join(other, "extra.txt"), "moved\n")
      git(other, ["add", "extra.txt"])
      git(other, ["commit", "-m", "remote move"])
      git(other, ["push", "origin", "main"])

      expect(() =>
        fastForwardLocalMain({
          repoRoot,
          baseSha,
          branch,
          candidateSha,
          pushOrigin: true,
        }),
      ).toThrow(IntegrateError)
      expect(git(repoRoot, ["rev-parse", "main"])).toBe(baseSha)
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
    }
  })
})
