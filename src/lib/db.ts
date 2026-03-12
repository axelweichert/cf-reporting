/**
 * SQLite singleton with lazy initialization and graceful degradation.
 *
 * Opens /app/data/cf-reporting.db on first call to getDb().
 * If the directory is unwritable (no volume mounted), returns null –
 * the app works identically to today without persistent storage.
 */

import type Database from "better-sqlite3";

let _db: Database.Database | null = null;
let _initFailed = false;

const DB_PATH = process.env.DB_PATH || "/app/data/cf-reporting.db";
const SCHEMA_VERSION = 2;

export function getDb(): Database.Database | null {
  if (_initFailed) return null;
  if (_db) return _db;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require("better-sqlite3") as (filename: string) => Database.Database;
    _db = BetterSqlite3(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("busy_timeout = 5000");

    runMigrations(_db);

    console.log("[db] SQLite initialized at", DB_PATH);
    return _db;
  } catch (err) {
    _initFailed = true;
    console.warn("[db] SQLite unavailable – running without persistent storage:", (err as Error).message);
    return null;
  }
}

export function isDbAvailable(): boolean {
  return getDb() !== null;
}

function runMigrations(db: Database.Database): void {
  // Create migrations table if it doesn't exist
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);

  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
  const currentVersion = row?.version || 0;

  if (currentVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS report_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        zone_id TEXT NOT NULL,
        zone_name TEXT NOT NULL,
        report_type TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        data_json TEXT NOT NULL,
        collected_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(zone_id, report_type, period_start, period_end)
      );

      CREATE TABLE IF NOT EXISTS collection_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        zone_id TEXT NOT NULL,
        zone_name TEXT NOT NULL,
        report_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('success','error','skipped')),
        error_message TEXT,
        duration_ms INTEGER,
        started_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_zone_type
        ON report_snapshots(zone_id, report_type);
      CREATE INDEX IF NOT EXISTS idx_snapshots_collected
        ON report_snapshots(collected_at);
      CREATE INDEX IF NOT EXISTS idx_collection_log_run
        ON collection_log(run_id);
    `);
  }

  if (currentVersion < 2) {
    // v2: Clear old overlapping snapshots from the 7-day-window era.
    // The collector now fetches incrementally (only new data since last run),
    // so old overlapping snapshots are redundant and waste space.
    db.exec(`DELETE FROM report_snapshots`);
    console.log("[db] Migration v2: cleared old overlapping snapshots – collector will refill incrementally");
  }

  // Upsert schema version
  if (currentVersion === 0) {
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  } else if (currentVersion < SCHEMA_VERSION) {
    db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
  }
}

/** Gracefully close the database connection (for tests / shutdown). */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
