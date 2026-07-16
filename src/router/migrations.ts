import type Database from "better-sqlite3"

export const ROUTER_SCHEMA_VERSION = 1

export function migrateRouterDatabase(db: Database.Database): void {
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.pragma("busy_timeout = 5000")

  db.exec(`
    CREATE TABLE IF NOT EXISTS router_migrations (
      version INTEGER PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      event_type TEXT NOT NULL,
      received_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS destinations (
      destination_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL REFERENCES events(event_id),
      destination_key TEXT NOT NULL REFERENCES destinations(destination_key),
      state TEXT NOT NULL CHECK(state IN ('pending', 'leased', 'delivered', 'dead')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at_ms INTEGER NOT NULL,
      leased_until_ms INTEGER,
      duplicate_risk INTEGER NOT NULL DEFAULT 0,
      delivered_at_ms INTEGER,
      UNIQUE(event_id, destination_key)
    );

    CREATE INDEX IF NOT EXISTS deliveries_ready_idx
      ON deliveries(state, next_attempt_at_ms);

    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
      attempted_at_ms INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      status_code INTEGER,
      detail TEXT,
      duplicate_risk INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS nonces (
      nonce TEXT PRIMARY KEY,
      expires_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS nonces_expiry_idx ON nonces(expires_at_ms);

    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      event_id TEXT,
      detail TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
  `)

  db.prepare(
    "INSERT OR IGNORE INTO router_migrations(version, applied_at_ms) VALUES (?, ?)",
  ).run(ROUTER_SCHEMA_VERSION, Date.now())
}
