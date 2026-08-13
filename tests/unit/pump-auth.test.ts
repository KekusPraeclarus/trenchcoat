import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import {
  assertPumpImportPathSafe,
  assertPumpProfileReady,
  chromeCookiesToPlaywright,
  cookieHeaderToPlaywright,
  importPumpSession,
  pumpCookiesLookAuthed,
  pumpSessionExists,
  waitForOperatorEnter,
} from "../../src/collectors/social/pump-auth.js"

describe("pump auth path asserts", () => {
  it("throws when storage-state is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pump-auth-missing-"))
    expect(() => assertPumpProfileReady(dir)).toThrow(/No pump\.fun session/u)
  })

  it("throws when storage-state is malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "pump-auth-bad-"))
    writeFileSync(join(dir, "storage-state.json"), "{not-json")
    expect(() => assertPumpProfileReady(dir)).toThrow(/malformed/u)
  })

  it("accepts minimal valid storage-state shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "pump-auth-ok-"))
    writeFileSync(join(dir, "storage-state.json"), JSON.stringify({ cookies: [], origins: [] }))
    expect(assertPumpProfileReady(dir)).toBe(join(dir, "storage-state.json"))
  })

  it("pumpSessionExists is a boolean without a home profile", () => {
    expect(typeof pumpSessionExists()).toBe("boolean")
  })
})

describe("pump login cookie heuristic", () => {
  it("rejects anonymous Privy session cookies", () => {
    expect(pumpCookiesLookAuthed([
      { name: "privy-session", value: "anon-session-cookie-value" },
      { name: "session", value: "abcdefghijklmnop" },
      { name: "did", value: "did:privy:anonymous-id" },
    ])).toBe(false)
  })

  it("accepts a Privy identity token", () => {
    expect(pumpCookiesLookAuthed([
      { name: "privy-session", value: "anon-session-cookie-value" },
      { name: "privy-token", value: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9xx" },
    ])).toBe(true)
  })
})

describe("pump auth operator Enter", () => {
  it("resolves when stdin receives a line", async () => {
    const stdin = Readable.from(["\n"])
    const chunks: string[] = []
    const stdout = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk))
        cb()
      },
    })
    await waitForOperatorEnter(1_000, { stdin, stdout })
    expect(chunks.join("")).toMatch(/Press Enter/u)
  })

  it("rejects when the operator does not press Enter in time", async () => {
    const stdin = new Readable({ read() { /* hang until timeout */ } })
    const stdout = new Writable({ write(_chunk, _enc, cb) { cb() } })
    await expect(waitForOperatorEnter(40, { stdin, stdout })).rejects.toThrow(/Timed out/u)
  })
})

describe("pump session import", () => {
  it("maps Cookie-Editor sameSite none to Playwright None", () => {
    const cookies = chromeCookiesToPlaywright([
      {
        name: "privy-token",
        value: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9xx",
        domain: ".privy.io",
        path: "/",
        expirationDate: 1_900_000_000,
        httpOnly: true,
        secure: true,
        sameSite: "no_restriction",
      },
    ])
    expect(cookies[0]?.sameSite).toBe("None")
    expect(cookies[0]?.domain).toBe(".privy.io")
  })

  it("writes storage-state from cookies and localStorage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pump-import-ok-"))
    const cookiesPath = join(dir, "import-cookies.json")
    const localPath = join(dir, "import-local-storage.json")
    writeFileSync(cookiesPath, JSON.stringify([
      {
        name: "privy-token",
        value: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9xx",
        domain: ".pump.fun",
        secure: true,
        httpOnly: true,
      },
    ]))
    writeFileSync(localPath, JSON.stringify({
      "privy:token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9-local-storage-token",
    }))
    const result = await importPumpSession({
      destDir: dir,
      cookiesPath,
      localStoragePath: localPath,
    })
    expect(result.cookieCount).toBe(1)
    expect(result.localStorageCount).toBe(1)
    expect(result.looksAuthed).toBe(true)
    expect(assertPumpProfileReady(dir)).toBe(result.path)
  })

  it("rejects import paths under agent/", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-import-agent-"))
    const agentDir = join(root, "agent")
    mkdirSync(agentDir)
    const cookiesPath = join(agentDir, "cookies.json")
    writeFileSync(cookiesPath, "[]")
    expect(() => assertPumpImportPathSafe(cookiesPath)).toThrow(/must not live under agent/u)
    await expect(importPumpSession({ destDir: root, cookiesPath })).rejects.toThrow(
      /must not live under agent/u,
    )
  })

  it("omits file contents from JSON parse errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pump-import-bad-"))
    const secret = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret-payload-value"
    const cookiesPath = join(dir, "import-cookies.json")
    writeFileSync(cookiesPath, `{not-json ${secret}`)
    await expect(importPumpSession({ destDir: dir, cookiesPath })).rejects.toThrow(
      /not valid JSON/u,
    )
    try {
      await importPumpSession({ destDir: dir, cookiesPath })
    } catch (err) {
      expect(String(err)).not.toContain(secret)
    }
  })

  it("parses a DevTools Cookie request header", () => {
    const cookies = cookieHeaderToPlaywright(
      "Cookie: privy-token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9xx; other=abc",
    )
    expect(cookies).toHaveLength(2)
    expect(cookies[0]?.name).toBe("privy-token")
    expect(cookies[0]?.domain).toBe(".pump.fun")
    expect(pumpCookiesLookAuthed(cookies)).toBe(true)
  })

  it("imports a cookie header with localStorage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pump-import-header-"))
    const headerPath = join(dir, "import-cookie-header.txt")
    const localPath = join(dir, "import-local-storage.json")
    writeFileSync(headerPath, "privy-token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9xx")
    writeFileSync(localPath, JSON.stringify({
      "privy:token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9-local-storage-token",
    }))
    const result = await importPumpSession({
      destDir: dir,
      cookieHeaderPath: headerPath,
      localStoragePath: localPath,
    })
    expect(result.cookieCount).toBe(1)
    expect(result.localStorageCount).toBe(1)
    expect(result.looksAuthed).toBe(true)
  })
})
