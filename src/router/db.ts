import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

export const ROUTER_SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  run_id TEXT NOT NULL,
  accepted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS destinations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER,
  duplicate_risk INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  provider_message_ids TEXT,
  UNIQUE(event_id, destination_id),
  FOREIGN KEY(event_id) REFERENCES events(event_id),
  FOREIGN KEY(destination_id) REFERENCES destinations(id)
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT,
  FOREIGN KEY(delivery_id) REFERENCES deliveries(id)
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
`

export function openRouterDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new Database(path)
  db.exec(ROUTER_SCHEMA_SQL)
  db.prepare(
    `INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1')`,
  ).run()
  // Additive migration for provider message ids (idempotent)
  try {
    const cols = db.prepare(`PRAGMA table_info(deliveries)`).all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === "provider_message_ids")) {
      db.exec(`ALTER TABLE deliveries ADD COLUMN provider_message_ids TEXT`)
    }
  } catch {
    // ignore
  }
  return db
}

export function purgeOldNonces(db: Database.Database, olderThanMs: number): void {
  db.prepare(`DELETE FROM nonces WHERE seen_at < ?`).run(olderThanMs)
}
