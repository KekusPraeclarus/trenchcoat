import { createHash } from "node:crypto"

export type JsonPrimitive = boolean | null | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

function canonicalize(value: JsonValue): JsonValue {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Canonical JSON rejects non-finite numbers")
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    )
  }

  return value
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalize(value))
}

export function sha256Json(value: JsonValue): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`
}
