import { sha256Json, type JsonValue } from "../lib/canonical-json.js"

export type NormalizedRecord<T extends JsonValue> = Readonly<{
  source: string
  fetchedAt: string
  provenance: string
  rawHash: `sha256:${string}`
  value: T
}>

export function normalizeRecord<T extends JsonValue>(
  source: string,
  fetchedAt: string,
  provenance: string,
  raw: JsonValue,
  value: T,
): NormalizedRecord<T> {
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(source)) throw new TypeError("Invalid collector source")
  if (!provenance.trim() || provenance.length > 256) throw new TypeError("Invalid record provenance")
  if (Number.isNaN(Date.parse(fetchedAt))) throw new TypeError("Invalid fetchedAt timestamp")
  return { source, fetchedAt, provenance, rawHash: sha256Json(raw), value }
}

export function rawArchiveHash(raw: JsonValue): `sha256:${string}` {
  return sha256Json(raw)
}
