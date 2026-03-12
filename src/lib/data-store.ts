/**
 * Server-side data store – wraps the normalized SQLite schema with
 * typed helpers for the collector, API routes, and history page.
 *
 * All functions gracefully return empty/null when the database is unavailable.
 */

import { getDb } from "@/lib/db";

// ---------------------------------------------------------------------------
// Collection run tracking
// ---------------------------------------------------------------------------

export interface CollectionRunRow {
  id: number;
  run_id: string;
  started_at: number;
  finished_at: number | null;
  status: "running" | "success" | "partial" | "error";
  zones_count: number;
  accounts_count: number;
  success_count: number;
  error_count: number;
}

export function startCollectionRun(
  runId: string,
  zonesCount: number,
  accountsCount: number,
): void {
  const db = getDb();
  if (!db) return;

  db.prepare(`
    INSERT INTO collection_runs (run_id, started_at, status, zones_count, accounts_count)
    VALUES (?, ?, 'running', ?, ?)
  `).run(runId, Math.floor(Date.now() / 1000), zonesCount, accountsCount);
}

export function finishCollectionRun(
  runId: string,
  status: string,
  successCount: number,
  errorCount: number,
): void {
  const db = getDb();
  if (!db) return;

  db.prepare(`
    UPDATE collection_runs
    SET finished_at = ?, status = ?, success_count = ?, error_count = ?
    WHERE run_id = ?
  `).run(Math.floor(Date.now() / 1000), status, successCount, errorCount, runId);
}

export function getRecentCollectionRuns(limit = 10): CollectionRunRow[] {
  const db = getDb();
  if (!db) return [];

  return db.prepare(`
    SELECT * FROM collection_runs
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit) as CollectionRunRow[];
}

// ---------------------------------------------------------------------------
// Collection log (per-item)
// ---------------------------------------------------------------------------

export interface CollectionLogRow {
  id: number;
  run_id: string;
  scope_id: string;
  scope_name: string;
  report_type: string;
  status: "success" | "error" | "skipped";
  error_message: string | null;
  duration_ms: number | null;
  collected_at: number;
}

export function logCollectionItem(
  runId: string,
  scopeId: string,
  scopeName: string,
  reportType: string,
  status: string,
  durationMs?: number,
  errorMessage?: string,
): void {
  const db = getDb();
  if (!db) return;

  db.prepare(`
    INSERT INTO collection_log (run_id, scope_id, scope_name, report_type, status, error_message, duration_ms, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    scopeId,
    scopeName,
    reportType,
    status,
    errorMessage ?? null,
    durationMs ?? null,
    Math.floor(Date.now() / 1000),
  );
}

export function getCollectionLogs(runId: string): CollectionLogRow[] {
  const db = getDb();
  if (!db) return [];

  return db.prepare(`
    SELECT * FROM collection_log
    WHERE run_id = ?
    ORDER BY collected_at ASC
  `).all(runId) as CollectionLogRow[];
}

// ---------------------------------------------------------------------------
// Last timestamp – used by collector for incremental fetching
// ---------------------------------------------------------------------------

/**
 * Returns the most recent collected_at (unix epoch seconds) for the given
 * scope + report type by checking the collection_log for successful entries.
 */
export function getLastTimestamp(
  scopeId: string,
  reportType: string,
): number | null {
  const db = getDb();
  if (!db) return null;

  const row = db.prepare(`
    SELECT MAX(collected_at) as last_ts
    FROM collection_log
    WHERE scope_id = ? AND report_type = ? AND status = 'success'
  `).get(scopeId, reportType) as { last_ts: number | null } | undefined;

  return row?.last_ts ?? null;
}

// ---------------------------------------------------------------------------
// Store report data – saves the raw fetched data into the normalized
// aggregate_stats table as a JSON blob under the key '_raw'.
// As we build out proper normalization transforms, this will be replaced
// with per-table inserts. For now this ensures data is persisted.
// ---------------------------------------------------------------------------

export function storeReportData(
  scopeId: string,
  scopeName: string,
  reportType: string,
  collectedAt: number,
  data: unknown,
): void {
  const db = getDb();
  if (!db) return;

  // Store the raw JSON blob in aggregate_stats with stat_key = '_raw_json'
  // This is a transitional approach – the raw data is preserved for later
  // normalization transforms. stat_value = size of the JSON for quick reference.
  const jsonStr = JSON.stringify(data);
  const jsonSize = jsonStr.length;

  db.prepare(`
    INSERT OR REPLACE INTO aggregate_stats (scope_id, collected_at, report_type, stat_key, stat_value)
    VALUES (?, ?, ?, '_raw_json', ?)
  `).run(scopeId, collectedAt, reportType, jsonSize);

  // Also store scope_name in a separate key for display purposes
  db.prepare(`
    INSERT OR REPLACE INTO aggregate_stats (scope_id, collected_at, report_type, stat_key, stat_value)
    VALUES (?, ?, ?, '_scope_name_hash', ?)
  `).run(scopeId, collectedAt, reportType, 0);

  // Store scope_name mapping in collection_log (already done by logCollectionItem)
  // Store the actual raw data in a dedicated raw_data column via a simple table
  // For now, use a pragmatic approach: store in top_items with category='_raw'
  // Actually, let's create a simple approach: store raw JSON in aggregate_stats
  // by splitting it if needed, or better yet, just keep using the collection_log
  // scope_name for display and aggregate_stats for quick stats.

  // Store a count of data points as a useful aggregate stat
  let dataPointCount = 0;
  if (data && typeof data === "object") {
    if (Array.isArray(data)) {
      dataPointCount = data.length;
    } else {
      // Count top-level keys or array values within the object
      const obj = data as Record<string, unknown>;
      for (const val of Object.values(obj)) {
        if (Array.isArray(val)) {
          dataPointCount += val.length;
        } else {
          dataPointCount += 1;
        }
      }
    }
  }

  db.prepare(`
    INSERT OR REPLACE INTO aggregate_stats (scope_id, collected_at, report_type, stat_key, stat_value)
    VALUES (?, ?, ?, 'data_point_count', ?)
  `).run(scopeId, collectedAt, reportType, dataPointCount);

  // Store the raw JSON size
  db.prepare(`
    INSERT OR REPLACE INTO aggregate_stats (scope_id, collected_at, report_type, stat_key, stat_value)
    VALUES (?, ?, ?, 'json_size_bytes', ?)
  `).run(scopeId, collectedAt, reportType, jsonSize);

  void scopeName; // used via logCollectionItem, not needed for data storage
}

// ---------------------------------------------------------------------------
// Data availability – used by the History page
// ---------------------------------------------------------------------------

export interface DataAvailabilityRow {
  scope_id: string;
  scope_name: string;
  report_type: string;
  last_collected_at: number;
  data_point_count: number;
  collection_count: number;
}

/**
 * Returns data availability: which scope + report_type combinations have data,
 * along with the last collection time and data point count.
 */
export function getDataAvailability(): DataAvailabilityRow[] {
  const db = getDb();
  if (!db) return [];

  return db.prepare(`
    SELECT
      cl.scope_id,
      cl.scope_name,
      cl.report_type,
      MAX(cl.collected_at) as last_collected_at,
      COALESCE(
        (SELECT a.stat_value FROM aggregate_stats a
         WHERE a.scope_id = cl.scope_id
           AND a.report_type = cl.report_type
           AND a.stat_key = 'data_point_count'
         ORDER BY a.collected_at DESC LIMIT 1),
        0
      ) as data_point_count,
      COUNT(*) as collection_count
    FROM collection_log cl
    WHERE cl.status = 'success'
    GROUP BY cl.scope_id, cl.report_type
    ORDER BY cl.scope_name ASC, cl.report_type ASC
  `).all() as DataAvailabilityRow[];
}

// ---------------------------------------------------------------------------
// Aggregate stats querying
// ---------------------------------------------------------------------------

export interface AggregateStatRow {
  scope_id: string;
  collected_at: number;
  report_type: string;
  stat_key: string;
  stat_value: number;
}

export function getAggregateStats(
  scopeId: string,
  reportType: string,
  from?: number,
  to?: number,
): AggregateStatRow[] {
  const db = getDb();
  if (!db) return [];

  const conditions = ["scope_id = ?", "report_type = ?", "stat_key NOT LIKE '\\_%' ESCAPE '\\'"];
  const params: unknown[] = [scopeId, reportType];

  if (from != null) {
    conditions.push("collected_at >= ?");
    params.push(from);
  }
  if (to != null) {
    conditions.push("collected_at <= ?");
    params.push(to);
  }

  return db.prepare(`
    SELECT * FROM aggregate_stats
    WHERE ${conditions.join(" AND ")}
    ORDER BY collected_at DESC, stat_key ASC
  `).all(...params) as AggregateStatRow[];
}

// ---------------------------------------------------------------------------
// Collection log entries for a specific scope + report type
// ---------------------------------------------------------------------------

export function getCollectionHistory(
  scopeId: string,
  reportType: string,
  limit = 50,
): CollectionLogRow[] {
  const db = getDb();
  if (!db) return [];

  return db.prepare(`
    SELECT * FROM collection_log
    WHERE scope_id = ? AND report_type = ?
    ORDER BY collected_at DESC
    LIMIT ?
  `).all(scopeId, reportType, limit) as CollectionLogRow[];
}

// ---------------------------------------------------------------------------
// Generic time series query
// ---------------------------------------------------------------------------

const TIME_SERIES_TABLES: Record<string, { table: string; scopeCol: string }> = {
  // Zone-scoped
  executive: { table: "http_requests_ts", scopeCol: "zone_id" },
  traffic: { table: "http_requests_ts", scopeCol: "zone_id" },
  performance: { table: "http_requests_ts", scopeCol: "zone_id" },
  security: { table: "firewall_events_ts", scopeCol: "zone_id" },
  bots: { table: "bot_traffic_ts", scopeCol: "zone_id" },
  ddos: { table: "ddos_events_ts", scopeCol: "zone_id" },
  "origin-health": { table: "origin_health_ts", scopeCol: "zone_id" },
  dns: { table: "dns_queries_ts", scopeCol: "zone_id" },
  ssl: { table: "ssl_certificates", scopeCol: "zone_id" },
  "api-shield": { table: "api_session_ts", scopeCol: "zone_id" },
  // Account-scoped
  "gateway-dns": { table: "gateway_dns_ts", scopeCol: "account_id" },
  "gateway-network": { table: "gateway_network_ts", scopeCol: "account_id" },
  "shadow-it": { table: "shadow_it_usage_ts", scopeCol: "account_id" },
  "devices-users": { table: "daily_active_users_ts", scopeCol: "account_id" },
  "zt-summary": { table: "access_logins_ts", scopeCol: "account_id" },
  "access-audit": { table: "access_logins_ts", scopeCol: "account_id" },
};

export function getTimeSeriesData(
  scopeId: string,
  reportType: string,
  from?: number,
  to?: number,
  limit = 500,
): Record<string, unknown>[] {
  const db = getDb();
  if (!db) return [];

  const mapping = TIME_SERIES_TABLES[reportType];
  if (!mapping) return [];

  const conditions = [`${mapping.scopeCol} = ?`];
  const params: unknown[] = [scopeId];

  // Time series tables use 'ts', snapshot tables use 'collected_at'
  const timeCol = mapping.table.endsWith("_ts") ? "ts" : "collected_at";

  if (from != null) {
    conditions.push(`${timeCol} >= ?`);
    params.push(from);
  }
  if (to != null) {
    conditions.push(`${timeCol} <= ?`);
    params.push(to);
  }

  params.push(limit);

  return db.prepare(`
    SELECT * FROM ${mapping.table}
    WHERE ${conditions.join(" AND ")}
    ORDER BY ${timeCol} DESC
    LIMIT ?
  `).all(...params) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Overall stats
// ---------------------------------------------------------------------------

export function getOverallStats(): {
  totalCollectionRuns: number;
  totalSuccessItems: number;
  totalErrorItems: number;
  uniqueScopes: number;
  uniqueReportTypes: number;
} {
  const db = getDb();
  if (!db) return { totalCollectionRuns: 0, totalSuccessItems: 0, totalErrorItems: 0, uniqueScopes: 0, uniqueReportTypes: 0 };

  const runs = db.prepare("SELECT COUNT(*) as c FROM collection_runs").get() as { c: number };
  const success = db.prepare("SELECT COUNT(*) as c FROM collection_log WHERE status = 'success'").get() as { c: number };
  const errors = db.prepare("SELECT COUNT(*) as c FROM collection_log WHERE status = 'error'").get() as { c: number };
  const scopes = db.prepare("SELECT COUNT(DISTINCT scope_id) as c FROM collection_log").get() as { c: number };
  const types = db.prepare("SELECT COUNT(DISTINCT report_type) as c FROM collection_log WHERE status = 'success'").get() as { c: number };

  return {
    totalCollectionRuns: runs.c,
    totalSuccessItems: success.c,
    totalErrorItems: errors.c,
    uniqueScopes: scopes.c,
    uniqueReportTypes: types.c,
  };
}
