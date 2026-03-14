/**
 * Data store module – v5 (raw data lake).
 *
 * Handles:
 *   1. Collection run tracking (startRun, finishRun, logItem)
 *   2. REST snapshot storage (DNS records, SSL certs, health checks, etc.)
 *   3. Query helpers for collection status and data availability
 *
 * Raw GraphQL data storage is handled by collector/raw-store.ts.
 * Report data reading is handled by data-store-readers.ts.
 */

import { getDb } from "@/lib/db";
import type Database from "better-sqlite3";

import type { ScheduleConfig } from "@/types/email";
import type { DnsData } from "@/lib/queries/dns";
import type { OriginHealthData } from "@/lib/queries/origin-health";
import type { SslData } from "@/lib/queries/ssl";
import type { ApiShieldData } from "@/lib/queries/api-shield";
import type { DevicesUsersData } from "@/lib/queries/devices-users";


// =============================================================================
// Types
// =============================================================================

export interface CollectionRunSummary {
  runId: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  zonesCount: number;
  accountsCount: number;
  successCount: number;
  errorCount: number;
}

/** Row shape returned by the collection_runs table. */
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
  skipped_count: number;
}

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

export interface DataAvailabilityRow {
  scope_id: string;
  scope_name: string;
  report_type: string;
  last_collected_at: number;
  data_point_count: number;
  collection_count: number;
}


// =============================================================================
// Helpers
// =============================================================================

/** Convert ISO date string to unix epoch seconds. */
function toEpoch(dateStr: string): number {
  return Math.floor(new Date(dateStr).getTime() / 1000);
}


// =============================================================================
// REST snapshot store functions
// =============================================================================

/**
 * Store DNS records snapshot (REST data only).
 */
function storeDnsSnapshot(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: DnsData,
): void {
  db.transaction(() => {
    const recStmt = db.prepare(`
      INSERT INTO dns_records (zone_id, collected_at, record_id, name, type, content, ttl, proxied, query_count, has_nxdomain, status, days_since_modified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const rec of data.dnsRecords) {
      recStmt.run(
        scopeId, collectedAt,
        rec.id, rec.name, rec.type, rec.content, rec.ttl,
        rec.proxied ? 1 : 0,
        rec.queryCount, rec.hasNxdomain ? 1 : 0,
        rec.status, rec.daysSinceModified,
      );
    }
  })();
}

/**
 * Store SSL certificates and settings snapshot (REST data only).
 */
function storeSslSnapshot(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: SslData,
): void {
  db.transaction(() => {
    // Certificates -> ssl_certificates
    const certStmt = db.prepare(`
      INSERT INTO ssl_certificates (zone_id, collected_at, cert_id, type, hosts, status, authority, validity_days, expires_on, signature_algorithms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const cert of data.certificates) {
      certStmt.run(
        scopeId, collectedAt,
        cert.id, cert.type,
        JSON.stringify(cert.hosts),
        cert.status, cert.authority,
        cert.validityDays,
        cert.expiresOn,
        JSON.stringify(cert.signatureAlgorithms),
      );
    }

    // Settings -> ssl_settings
    const s = data.settings;
    db.prepare(`
      INSERT INTO ssl_settings (zone_id, collected_at, mode, min_tls_version, tls13_enabled, always_use_https, auto_https_rewrites, opportunistic_encryption, zero_rtt, http2_enabled, http3_enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scopeId, collectedAt,
      s.mode, s.minTlsVersion,
      s.tls13 === "on" || s.tls13 === "zrt" ? 1 : 0,
      s.alwaysUseHttps ? 1 : 0,
      s.autoHttpsRewrites ? 1 : 0,
      s.opportunisticEncryption ? 1 : 0,
      s.zeroRtt ? 1 : 0,
      s.http2 ? 1 : 0,
      s.http3 ? 1 : 0,
    );
  })();
}

/**
 * Store health checks and health events snapshot (REST data only).
 */
function storeOriginHealthSnapshot(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: OriginHealthData,
): void {
  db.transaction(() => {
    // Health checks -> health_checks
    const hcStmt = db.prepare(`
      INSERT INTO health_checks (zone_id, collected_at, name, status, address, type, interval_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const hc of data.healthChecks) {
      hcStmt.run(scopeId, collectedAt, hc.name, hc.status, hc.address, hc.type, hc.interval);
    }

    // Health events -> health_events
    const heStmt = db.prepare(`
      INSERT INTO health_events (zone_id, collected_at, event_time, name, status, origin_ip, response_status, rtt_ms, failure_reason, region)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const he of data.healthEvents) {
      const eventTime = toEpoch(he.datetime);
      heStmt.run(scopeId, collectedAt, eventTime, he.name, he.status, he.originIp, he.responseStatus, he.rttMs, he.failureReason, he.region);
    }
  })();
}

/**
 * Store API operations and discovered endpoints snapshot (REST data only).
 */
function storeApiShieldSnapshot(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: ApiShieldData,
): void {
  db.transaction(() => {
    // Managed operations -> api_operations
    const opStmt = db.prepare(`
      INSERT INTO api_operations (zone_id, collected_at, operation_id, method, host, endpoint, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const op of data.managedOperations) {
      opStmt.run(scopeId, collectedAt, op.operationId, op.method, op.host, op.endpoint, op.lastUpdated);
    }

    // Discovered endpoints -> api_discovered_endpoints
    const discStmt = db.prepare(`
      INSERT INTO api_discovered_endpoints (zone_id, collected_at, method, host, endpoint, state, avg_requests_per_hour)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const ep of data.discoveredEndpoints) {
      discStmt.run(scopeId, collectedAt, ep.method, ep.host, ep.endpoint, ep.state, ep.avgRequestsPerHour);
    }
  })();
}

/**
 * Store devices, users, and posture rules snapshot (REST data only).
 */
function storeDevicesUsersSnapshot(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: DevicesUsersData,
): void {
  db.transaction(() => {
    // Devices -> zt_devices
    const devStmt = db.prepare(`
      INSERT INTO zt_devices (account_id, collected_at, device_name, user_name, email, os, os_version, warp_version, last_seen, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const dev of data.devices) {
      const lastSeen = dev.lastSeen ? toEpoch(dev.lastSeen) : null;
      devStmt.run(scopeId, collectedAt, dev.name, dev.user, dev.email, dev.os, dev.osVersion, dev.warpVersion, lastSeen, dev.status);
    }

    // Users -> zt_users
    const userStmt = db.prepare(`
      INSERT INTO zt_users (account_id, collected_at, name, email, access_seat, gateway_seat, device_count, last_login)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const user of data.users) {
      const lastLogin = user.lastLogin ? toEpoch(user.lastLogin) : null;
      userStmt.run(scopeId, collectedAt, user.name, user.email, user.accessSeat ? 1 : 0, user.gatewaySeat ? 1 : 0, user.deviceCount, lastLogin);
    }

    // Posture rules -> zt_posture_rules
    const postureStmt = db.prepare(`
      INSERT INTO zt_posture_rules (account_id, collected_at, name, type, description, platform, input_json, scope_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const rule of data.postureRules) {
      postureStmt.run(scopeId, collectedAt, rule.name, rule.type, rule.description, rule.platform, rule.input, null);
    }
  })();
}


// =============================================================================
// Report type dispatcher
// =============================================================================

type SnapshotStoreFn = (db: Database.Database, scopeId: string, collectedAt: number, data: unknown) => void;

const STORE_FUNCTIONS: Record<string, SnapshotStoreFn> = {
  // Used by collector for REST snapshot storage
  "dns-records":              (db, s, c, d) => storeDnsSnapshot(db, s, c, d as DnsData),
  "ssl-snapshots":            (db, s, c, d) => storeSslSnapshot(db, s, c, d as SslData),
  "origin-health-snapshots":  (db, s, c, d) => storeOriginHealthSnapshot(db, s, c, d as OriginHealthData),
  "api-shield-snapshots":     (db, s, c, d) => storeApiShieldSnapshot(db, s, c, d as ApiShieldData),
  "devices-users":            (db, s, c, d) => storeDevicesUsersSnapshot(db, s, c, d as DevicesUsersData),

  // Legacy aliases (in case anything still uses old report type keys)
  dns:                        (db, s, c, d) => storeDnsSnapshot(db, s, c, d as DnsData),
  ssl:                        (db, s, c, d) => storeSslSnapshot(db, s, c, d as SslData),
  "origin-health":            (db, s, c, d) => storeOriginHealthSnapshot(db, s, c, d as OriginHealthData),
  "api-shield":               (db, s, c, d) => storeApiShieldSnapshot(db, s, c, d as ApiShieldData),
};


/**
 * Dispatch report data to the appropriate type-specific store function.
 * In v5, this only handles REST snapshot data (not GraphQL time series).
 */
export function storeReportData(
  scopeId: string,
  _scopeName: string,
  reportType: string,
  collectedAt: number,
  data: unknown,
): void {
  const db = getDb();
  if (!db) return;

  const storeFn = STORE_FUNCTIONS[reportType];
  if (!storeFn) {
    // Not a REST snapshot type – this is expected for raw GraphQL data
    return;
  }

  try {
    storeFn(db, scopeId, collectedAt, data);
  } catch (err) {
    console.error(`[data-store] Failed to store ${reportType} for ${scopeId}:`, (err as Error).message);
    throw err;
  }
}


// =============================================================================
// Last timestamp (backward compat for external consumers)
// =============================================================================

/** Maps old report-type keys to raw table last-timestamp queries. */
const LAST_TS_QUERIES: Record<string, string> = {
  executive:         "SELECT MAX(ts) as max_ts FROM raw_http_hourly WHERE zone_id = ?",
  security:          "SELECT MAX(ts) as max_ts FROM raw_fw_hourly WHERE zone_id = ?",
  traffic:           "SELECT MAX(ts) as max_ts FROM raw_http_hourly WHERE zone_id = ?",
  performance:       "SELECT MAX(ts) as max_ts FROM raw_http_hourly WHERE zone_id = ?",
  dns:               "SELECT MAX(ts) as max_ts FROM raw_dns_hourly WHERE zone_id = ?",
  "origin-health":   "SELECT MAX(ts) as max_ts FROM raw_health_events WHERE zone_id = ?",
  ssl:               "SELECT MAX(ts) as max_ts FROM raw_http_overview_hourly WHERE zone_id = ?",
  bots:              "SELECT MAX(ts) as max_ts FROM raw_http_hourly WHERE zone_id = ?",
  "api-shield":      "SELECT MAX(ts) as max_ts FROM raw_http_hourly WHERE zone_id = ?",
  ddos:              "SELECT MAX(ts) as max_ts FROM raw_fw_hourly WHERE zone_id = ?",
  "gateway-dns":     "SELECT MAX(ts) as max_ts FROM raw_gw_dns_hourly WHERE account_id = ?",
  "gateway-network": "SELECT MAX(ts) as max_ts FROM raw_gw_net_hourly WHERE account_id = ?",
  "shadow-it":       "SELECT MAX(ts) as max_ts FROM raw_gw_dns_hourly WHERE account_id = ?",
  "devices-users":   "SELECT MAX(collected_at) as max_ts FROM zt_devices WHERE account_id = ?",
  "zt-summary":      "SELECT MAX(ts) as max_ts FROM raw_access_daily WHERE account_id = ?",
  "access-audit":    "SELECT MAX(ts) as max_ts FROM raw_access_daily WHERE account_id = ?",
};

/**
 * Get the most recent timestamp from the relevant time series table.
 * Backward-compatible: accepts old report-type keys, queries raw tables.
 */
export function getLastTimestamp(scopeId: string, reportType: string): number | null {
  const db = getDb();
  if (!db) return null;

  const query = LAST_TS_QUERIES[reportType];
  if (!query) return null;

  try {
    const row = db.prepare(query).get(scopeId) as { max_ts: number | null } | undefined;
    return row?.max_ts ?? null;
  } catch {
    return null;
  }
}


// =============================================================================
// Collection tracking
// =============================================================================

/**
 * Insert a new collection_runs row with status='running'.
 */
export function startCollectionRun(runId: string, zonesCount: number, accountsCount: number): void {
  const db = getDb();
  if (!db) return;

  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO collection_runs (run_id, started_at, status, zones_count, accounts_count)
    VALUES (?, ?, 'running', ?, ?)
  `).run(runId, now, zonesCount, accountsCount);
}

/**
 * Update a collection_runs row with final status and counts.
 */
export function finishCollectionRun(
  runId: string,
  status: string,
  successCount: number,
  errorCount: number,
  skippedCount: number,
): void {
  const db = getDb();
  if (!db) return;

  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE collection_runs
    SET finished_at = ?, status = ?, success_count = ?, error_count = ?, skipped_count = ?
    WHERE run_id = ?
  `).run(now, status, successCount, errorCount, skippedCount, runId);
}

/**
 * Insert a row into collection_log.
 */
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

  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO collection_log (run_id, scope_id, scope_name, report_type, status, duration_ms, error_message, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(runId, scopeId, scopeName, reportType, status, durationMs ?? null, errorMessage ?? null, now);
}


// =============================================================================
// Query helpers
// =============================================================================

/**
 * Get recent collection runs (raw row format).
 */
export function getRecentCollectionRuns(limit = 10): CollectionRunRow[] {
  const db = getDb();
  if (!db) return [];

  return db.prepare(`
    SELECT * FROM collection_runs
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit) as CollectionRunRow[];
}

/**
 * Get collection log entries for a specific run.
 */
export function getCollectionLogs(runId: string): CollectionLogRow[] {
  const db = getDb();
  if (!db) return [];

  return db.prepare(`
    SELECT * FROM collection_log
    WHERE run_id = ?
    ORDER BY collected_at ASC
  `).all(runId) as CollectionLogRow[];
}

/**
 * Returns data availability: which scope + report_type combinations have data.
 */
export function getDataAvailability(): DataAvailabilityRow[] {
  const db = getDb();
  if (!db) return [];

  try {
    return db.prepare(`
      SELECT
        cl.scope_id,
        cl.scope_name,
        cl.report_type,
        MAX(cl.collected_at) as last_collected_at,
        COUNT(*) as data_point_count,
        COUNT(*) as collection_count
      FROM collection_log cl
      WHERE cl.status = 'success'
      GROUP BY cl.scope_id, cl.report_type
      ORDER BY cl.scope_name ASC, cl.report_type ASC
    `).all() as DataAvailabilityRow[];
  } catch {
    return [];
  }
}

/**
 * Get collection history for a specific scope + report type.
 */
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

/**
 * Get recent collection run summaries.
 */
export function getCollectionRunSummaries(limit: number = 20): CollectionRunSummary[] {
  const db = getDb();
  if (!db) return [];

  const rows = db.prepare(`
    SELECT run_id, started_at, finished_at, status, zones_count, accounts_count, success_count, error_count
    FROM collection_runs
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    run_id: string;
    started_at: number;
    finished_at: number | null;
    status: string;
    zones_count: number;
    accounts_count: number;
    success_count: number;
    error_count: number;
  }>;

  return rows.map((r) => ({
    runId: r.run_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    zonesCount: r.zones_count,
    accountsCount: r.accounts_count,
    successCount: r.success_count,
    errorCount: r.error_count,
  }));
}

/**
 * Overall statistics across all collections.
 */
export function getOverallStats(): {
  totalCollectionRuns: number;
  totalSuccessItems: number;
  totalErrorItems: number;
  totalSkippedItems: number;
  uniqueScopes: number;
  uniqueReportTypes: number;
} {
  const db = getDb();
  if (!db) return { totalCollectionRuns: 0, totalSuccessItems: 0, totalErrorItems: 0, totalSkippedItems: 0, uniqueScopes: 0, uniqueReportTypes: 0 };

  const runs = db.prepare("SELECT COUNT(*) as c FROM collection_runs").get() as { c: number };
  const success = db.prepare("SELECT COUNT(*) as c FROM collection_log WHERE status = 'success'").get() as { c: number };
  const errors = db.prepare("SELECT COUNT(*) as c FROM collection_log WHERE status = 'error'").get() as { c: number };
  const skipped = db.prepare("SELECT COUNT(*) as c FROM collection_log WHERE status = 'skipped'").get() as { c: number };
  const scopes = db.prepare("SELECT COUNT(DISTINCT scope_id) as c FROM collection_log").get() as { c: number };
  const types = db.prepare("SELECT COUNT(DISTINCT report_type) as c FROM collection_log WHERE status = 'success'").get() as { c: number };

  return {
    totalCollectionRuns: runs.c,
    totalSuccessItems: success.c,
    totalErrorItems: errors.c,
    totalSkippedItems: skipped.c,
    uniqueScopes: scopes.c,
    uniqueReportTypes: types.c,
  };
}

/** Table name mapping for time series queries (uses raw tables). */
const TIME_SERIES_TABLES: Record<string, { table: string; scopeCol: string }> = {
  executive:         { table: "raw_http_hourly", scopeCol: "zone_id" },
  traffic:           { table: "raw_http_hourly", scopeCol: "zone_id" },
  performance:       { table: "raw_http_hourly", scopeCol: "zone_id" },
  security:          { table: "raw_fw_hourly", scopeCol: "zone_id" },
  bots:              { table: "raw_http_hourly", scopeCol: "zone_id" },
  ddos:              { table: "raw_fw_hourly", scopeCol: "zone_id" },
  "origin-health":   { table: "raw_health_events", scopeCol: "zone_id" },
  dns:               { table: "raw_dns_hourly", scopeCol: "zone_id" },
  ssl:               { table: "raw_http_overview_hourly", scopeCol: "zone_id" },
  "api-shield":      { table: "raw_http_hourly", scopeCol: "zone_id" },
  "gateway-dns":     { table: "raw_gw_dns_hourly", scopeCol: "account_id" },
  "gateway-network": { table: "raw_gw_net_hourly", scopeCol: "account_id" },
  "shadow-it":       { table: "raw_gw_dns_hourly", scopeCol: "account_id" },
  "devices-users":   { table: "zt_devices", scopeCol: "account_id" },
  "zt-summary":      { table: "raw_access_daily", scopeCol: "account_id" },
  "access-audit":    { table: "raw_access_daily", scopeCol: "account_id" },
};

/**
 * Generic time series query for any report type.
 */
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

  const timeCol = mapping.table.endsWith("_ts") || mapping.table.startsWith("raw_") ? "ts" : "collected_at";

  if (from != null) {
    conditions.push(`${timeCol} >= ?`);
    params.push(from);
  }
  if (to != null) {
    conditions.push(`${timeCol} <= ?`);
    params.push(to);
  }

  params.push(limit);

  try {
    return db.prepare(`
      SELECT * FROM ${mapping.table}
      WHERE ${conditions.join(" AND ")}
      ORDER BY ${timeCol} DESC
      LIMIT ?
    `).all(...params) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

/**
 * Get aggregate stats – returns empty in v5 (aggregate_stats table was dropped).
 * Kept for backward compatibility with the snapshots API route.
 */
export function getAggregateStats(
  _scopeId: string,
  _reportType: string,
  _from?: number,
  _to?: number,
): Array<{ scope_id: string; collected_at: number; report_type: string; stat_key: string; stat_value: number }> {
  return [];
}


// =============================================================================
// Schedule persistence (email_schedules table)
// =============================================================================

interface ScheduleRow {
  id: string;
  enabled: number;
  report_type: string;
  frequency: string;
  cron_expression: string;
  hour: number;
  day_of_week: number | null;
  day_of_month: number | null;
  recipients: string;
  zone_id: string;
  zone_name: string;
  time_range: string;
  subject: string | null;
  created_at: string;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_error: string | null;
  account_id: string | null;
  account_name: string | null;
}

export function getSchedulesFromDb(): ScheduleConfig[] {
  const db = getDb();
  if (!db) return [];

  const rows = db.prepare("SELECT * FROM email_schedules ORDER BY created_at ASC").all() as ScheduleRow[];
  return rows.map((r) => ({
    id: r.id,
    enabled: r.enabled === 1,
    reportType: r.report_type as ScheduleConfig["reportType"],
    frequency: r.frequency as ScheduleConfig["frequency"],
    cronExpression: r.cron_expression,
    hour: r.hour,
    dayOfWeek: r.day_of_week ?? undefined,
    dayOfMonth: r.day_of_month ?? undefined,
    recipients: JSON.parse(r.recipients) as string[],
    zoneId: r.zone_id,
    zoneName: r.zone_name,
    timeRange: r.time_range as ScheduleConfig["timeRange"],
    subject: r.subject ?? undefined,
    createdAt: r.created_at,
    lastRunAt: r.last_run_at ?? undefined,
    lastRunStatus: r.last_run_status as ScheduleConfig["lastRunStatus"],
    lastRunError: r.last_run_error ?? undefined,
    accountId: r.account_id ?? undefined,
    accountName: r.account_name ?? undefined,
  }));
}

export function saveScheduleToDb(schedule: ScheduleConfig): void {
  const db = getDb();
  if (!db) return;

  db.prepare(`
    INSERT OR REPLACE INTO email_schedules
      (id, enabled, report_type, frequency, cron_expression, hour, day_of_week, day_of_month,
       recipients, zone_id, zone_name, time_range, subject, created_at, last_run_at, last_run_status, last_run_error,
       account_id, account_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    schedule.id,
    schedule.enabled ? 1 : 0,
    schedule.reportType,
    schedule.frequency,
    schedule.cronExpression,
    schedule.hour,
    schedule.dayOfWeek ?? null,
    schedule.dayOfMonth ?? null,
    JSON.stringify(schedule.recipients),
    schedule.zoneId,
    schedule.zoneName,
    schedule.timeRange,
    schedule.subject ?? null,
    schedule.createdAt,
    schedule.lastRunAt ?? null,
    schedule.lastRunStatus ?? null,
    schedule.lastRunError ?? null,
    schedule.accountId ?? null,
    schedule.accountName ?? null,
  );
}

export function deleteScheduleFromDb(id: string): boolean {
  const db = getDb();
  if (!db) return false;

  const result = db.prepare("DELETE FROM email_schedules WHERE id = ?").run(id);
  return result.changes > 0;
}

export function updateScheduleEnabledInDb(id: string, enabled: boolean): boolean {
  const db = getDb();
  if (!db) return false;

  const result = db.prepare("UPDATE email_schedules SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  return result.changes > 0;
}

export function updateScheduleRunStatusInDb(id: string, status: string, error?: string): void {
  const db = getDb();
  if (!db) return;

  db.prepare(
    "UPDATE email_schedules SET last_run_at = ?, last_run_status = ?, last_run_error = ? WHERE id = ?",
  ).run(new Date().toISOString(), status, error ?? null, id);
}
