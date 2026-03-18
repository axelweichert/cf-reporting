/**
 * Contract Usage – Product Catalog
 *
 * Maps each known Cloudflare enterprise line item to:
 * - display metadata (name, category, unit, description)
 * - a probe target for auto-detection
 * - a calculator function that derives monthly usage from raw SQLite tables
 *
 * All calculator functions receive (db, monthStart, monthEnd) where timestamps
 * are unix epoch seconds in UTC. They return { value, rawValue, dataAvailable }.
 */

import type Database from "better-sqlite3";
import type { ProductCatalogEntry, UsageResult } from "./types";

// =============================================================================
// Helpers
// =============================================================================

const TB = 1e12;
const GB = 1e9;
const MM = 1e6;
const TEN_K = 1e4;
const HUNDRED_K = 1e5;
const THOUSAND = 1e3;

function noData(): UsageResult {
  return { value: 0, rawValue: 0, dataAvailable: false };
}

function result(rawValue: number, divisor: number): UsageResult {
  return {
    value: Math.round((rawValue / divisor) * 100) / 100,
    rawValue,
    dataAvailable: true,
  };
}

/** SUM a single column from raw_http_hourly across all zones for a month. */
function sumHttpColumn(
  db: Database.Database, column: string, start: number, end: number,
): number | null {
  const row = db.prepare(
    `SELECT COALESCE(SUM(${column}), 0) AS total, COUNT(*) AS cnt
     FROM raw_http_hourly WHERE ts >= ? AND ts < ?`,
  ).get(start, end) as { total: number; cnt: number } | undefined;
  if (!row || row.cnt === 0) return null;
  return row.total;
}

/** SUM queries from raw_dns_hourly across all zones for a month. */
function sumDnsQueries(
  db: Database.Database, start: number, end: number,
): number | null {
  const row = db.prepare(
    `SELECT COALESCE(SUM(queries), 0) AS total, COUNT(*) AS cnt
     FROM raw_dns_hourly WHERE ts >= ? AND ts < ?`,
  ).get(start, end) as { total: number; cnt: number } | undefined;
  if (!row || row.cnt === 0) return null;
  return row.total;
}

/** SUM a metric from raw_ext_ts for a given dataset key. */
function sumExtTs(
  db: Database.Database, dataset: string, metric: string, start: number, end: number,
): number | null {
  const row = db.prepare(
    `SELECT COALESCE(SUM(value), 0) AS total, COUNT(*) AS cnt
     FROM raw_ext_ts WHERE dataset = ? AND metric = ? AND ts >= ? AND ts < ?`,
  ).get(dataset, metric, start, end) as { total: number; cnt: number } | undefined;
  if (!row || row.cnt === 0) return null;
  return row.total;
}

/** MAX of a metric from raw_ext_ts (for storage metrics). */
function maxExtTs(
  db: Database.Database, dataset: string, metric: string, start: number, end: number,
): number | null {
  const row = db.prepare(
    `SELECT COALESCE(MAX(value), 0) AS peak, COUNT(*) AS cnt
     FROM raw_ext_ts WHERE dataset = ? AND metric = ? AND ts >= ? AND ts < ?`,
  ).get(dataset, metric, start, end) as { peak: number; cnt: number } | undefined;
  if (!row || row.cnt === 0) return null;
  return row.peak;
}

/**
 * Average of daily MAX values for a storage metric (mimics CF billing for R2).
 * Groups by day, takes MAX per day, then averages across days.
 */
function avgDailyMaxExtTs(
  db: Database.Database, dataset: string, metric: string, start: number, end: number,
): number | null {
  const rows = db.prepare(
    `SELECT MAX(value) AS daily_max
     FROM raw_ext_ts
     WHERE dataset = ? AND metric = ? AND ts >= ? AND ts < ?
     GROUP BY (ts / 86400)`,
  ).all(dataset, metric, start, end) as Array<{ daily_max: number }>;
  if (rows.length === 0) return null;
  const sum = rows.reduce((acc, r) => acc + r.daily_max, 0);
  return sum / rows.length;
}

/**
 * SUM of a metric from raw_ext_dim filtered by dimension key values.
 * Used for R2 Class A/B ops and KV read/write separation.
 */
function sumExtDimFiltered(
  db: Database.Database, dataset: string, dimName: string,
  keys: string[], metric: string, start: number, end: number,
): number | null {
  const placeholders = keys.map(() => "?").join(",");
  const row = db.prepare(
    `SELECT COALESCE(SUM(value), 0) AS total, COUNT(*) AS cnt
     FROM raw_ext_dim
     WHERE dataset = ? AND dim = ? AND key IN (${placeholders})
       AND metric = ? AND ts >= ? AND ts < ?`,
  ).get(dataset, dimName, ...keys, metric, start, end) as { total: number; cnt: number } | undefined;
  if (!row || row.cnt === 0) return null;
  return row.total;
}

// =============================================================================
// Product Catalog
// =============================================================================

// R2 Class A action types (mutate operations)
const R2_CLASS_A_ACTIONS = [
  "PutObject", "CopyObject", "ListBucket", "ListMultipartUploads",
  "CreateMultipartUpload", "CompleteMultipartUpload", "AbortMultipartUpload",
  "UploadPart", "UploadPartCopy", "DeleteObject", "DeleteObjects",
];

// R2 Class B action types (read operations)
const R2_CLASS_B_ACTIONS = [
  "GetObject", "HeadObject", "HeadBucket",
];

export const PRODUCT_CATALOG: ProductCatalogEntry[] = [
  // ===== CDN =====
  {
    key: "cdn-data-transfer",
    displayName: "CDN \u2013 Data Transfer",
    category: "CDN",
    unit: "TB",
    description: "Total edge data transfer (edgeResponseBytes) across all zones",
    probeTable: { type: "raw_http" },
    calculator: (db, start, end) => {
      const raw = sumHttpColumn(db, "bytes", start, end);
      return raw === null ? noData() : result(raw, TB);
    },
  },
  {
    key: "cdn-requests",
    displayName: "CDN \u2013 Requests",
    category: "CDN",
    unit: "MM",
    description: "Total HTTP requests across all zones",
    probeTable: { type: "raw_http" },
    calculator: (db, start, end) => {
      const raw = sumHttpColumn(db, "requests", start, end);
      return raw === null ? noData() : result(raw, MM);
    },
  },

  // ===== WAF =====
  {
    key: "waf-data-transfer",
    displayName: "WAF \u2013 Data Transfer",
    category: "WAF",
    unit: "TB",
    description: "WAF-processed data transfer (same as CDN \u2013 WAF inspects all traffic)",
    probeTable: { type: "always" },
    calculator: (db, start, end) => {
      const raw = sumHttpColumn(db, "bytes", start, end);
      return raw === null ? noData() : result(raw, TB);
    },
  },
  {
    key: "waf-requests",
    displayName: "WAF \u2013 Requests",
    category: "WAF",
    unit: "MM",
    description: "WAF-processed requests (same as CDN \u2013 WAF inspects all traffic)",
    probeTable: { type: "always" },
    calculator: (db, start, end) => {
      const raw = sumHttpColumn(db, "requests", start, end);
      return raw === null ? noData() : result(raw, MM);
    },
  },

  // ===== Bot Management =====
  {
    key: "bot-mgmt-requests",
    displayName: "Bot Management \u2013 Requests",
    category: "Bot Management",
    unit: "MM",
    description: "Requests evaluated by Bot Management (all HTTP traffic)",
    probeTable: { type: "always" },
    calculator: (db, start, end) => {
      const raw = sumHttpColumn(db, "requests", start, end);
      return raw === null ? noData() : result(raw, MM);
    },
  },

  // ===== Rate Limiting =====
  {
    key: "rate-limiting-requests",
    displayName: "Rate Limiting \u2013 Requests",
    category: "Rate Limiting",
    unit: "MM",
    description: "Requests evaluated by Rate Limiting rules (all HTTP traffic)",
    probeTable: { type: "always" },
    calculator: (db, start, end) => {
      const raw = sumHttpColumn(db, "requests", start, end);
      return raw === null ? noData() : result(raw, MM);
    },
  },

  // ===== Foundation DNS =====
  {
    key: "dns-queries",
    displayName: "Foundation DNS \u2013 Queries",
    category: "DNS",
    unit: "MM",
    description: "Total authoritative DNS queries across all zones",
    probeTable: { type: "raw_dns" },
    calculator: (db, start, end) => {
      const raw = sumDnsQueries(db, start, end);
      return raw === null ? noData() : result(raw, MM);
    },
  },
  {
    key: "dns-records",
    displayName: "Foundation DNS \u2013 Records",
    category: "DNS",
    unit: "10K records",
    description: "Total DNS records across all zones (latest snapshot)",
    probeTable: { type: "dns_records" },
    calculator: (db) => {
      // Count distinct records from the most recent collection
      const row = db.prepare(
        `SELECT COUNT(DISTINCT record_id) AS cnt
         FROM dns_records
         WHERE collected_at = (SELECT MAX(collected_at) FROM dns_records)`,
      ).get() as { cnt: number } | undefined;
      if (!row || row.cnt === 0) return noData();
      return result(row.cnt, TEN_K);
    },
  },

  // ===== Workers =====
  {
    key: "workers-requests",
    displayName: "Workers \u2013 Requests",
    category: "Workers",
    unit: "MM",
    description: "Total Worker invocations across all scripts",
    probeTable: { type: "ext", dataset: "ext:workers" },
    calculator: (db, start, end) => {
      const raw = sumExtTs(db, "ext:workers", "sum.requests", start, end);
      return raw === null ? noData() : result(raw, MM);
    },
  },
  {
    key: "workers-cpu-time",
    displayName: "Workers \u2013 CPU Time",
    category: "Workers",
    unit: "MM ms",
    description: "Total Worker CPU time consumed",
    probeTable: { type: "ext", dataset: "ext:workers" },
    calculator: (db, start, end) => {
      // Stored as microseconds, convert to milliseconds then to millions
      const raw = sumExtTs(db, "ext:workers", "sum.cpuTimeUs", start, end);
      if (raw === null) return noData();
      const ms = raw / THOUSAND;
      return result(ms, MM);
    },
  },

  // ===== R2 =====
  {
    key: "r2-storage",
    displayName: "R2 \u2013 Storage",
    category: "R2",
    unit: "TB",
    description: "Average daily peak R2 storage (GB-month billing model)",
    probeTable: { type: "ext", dataset: "ext:r2-storage" },
    calculator: (db, start, end) => {
      const raw = avgDailyMaxExtTs(db, "ext:r2-storage", "max.payloadSize", start, end);
      return raw === null ? noData() : result(raw, TB);
    },
  },
  {
    key: "r2-class-a-ops",
    displayName: "R2 \u2013 Class A Operations",
    category: "R2",
    unit: "MM",
    description: "Mutating R2 operations (Put, Copy, List, Delete, etc.)",
    probeTable: { type: "ext_dim", dataset: "ext:r2-ops" },
    calculator: (db, start, end) => {
      const raw = sumExtDimFiltered(
        db, "ext:r2-ops", "actionType", R2_CLASS_A_ACTIONS, "sum.requests", start, end,
      );
      return raw === null ? noData() : result(raw, MM);
    },
  },
  {
    key: "r2-class-b-ops",
    displayName: "R2 \u2013 Class B Operations",
    category: "R2",
    unit: "MM",
    description: "Read R2 operations (Get, Head)",
    probeTable: { type: "ext_dim", dataset: "ext:r2-ops" },
    calculator: (db, start, end) => {
      const raw = sumExtDimFiltered(
        db, "ext:r2-ops", "actionType", R2_CLASS_B_ACTIONS, "sum.requests", start, end,
      );
      return raw === null ? noData() : result(raw, MM);
    },
  },

  // ===== KV =====
  {
    key: "kv-reads",
    displayName: "Workers KV \u2013 Reads",
    category: "KV",
    unit: "MM",
    description: "KV read operations",
    probeTable: { type: "ext_dim", dataset: "ext:kv-ops" },
    calculator: (db, start, end) => {
      const raw = sumExtDimFiltered(
        db, "ext:kv-ops", "actionType", ["read"], "sum.requests", start, end,
      );
      return raw === null ? noData() : result(raw, MM);
    },
  },
  {
    key: "kv-writes",
    displayName: "Workers KV \u2013 Writes",
    category: "KV",
    unit: "MM",
    description: "KV write, delete, and list operations",
    probeTable: { type: "ext_dim", dataset: "ext:kv-ops" },
    calculator: (db, start, end) => {
      const raw = sumExtDimFiltered(
        db, "ext:kv-ops", "actionType", ["write", "delete", "list"], "sum.requests", start, end,
      );
      return raw === null ? noData() : result(raw, MM);
    },
  },
  {
    key: "kv-storage",
    displayName: "Workers KV \u2013 Storage",
    category: "KV",
    unit: "GB",
    description: "Peak KV storage in the period",
    probeTable: { type: "ext", dataset: "ext:kv-storage" },
    calculator: (db, start, end) => {
      const raw = maxExtTs(db, "ext:kv-storage", "max.byteCount", start, end);
      return raw === null ? noData() : result(raw, GB);
    },
  },

  // ===== Images =====
  {
    key: "images-delivered",
    displayName: "Images \u2013 Delivered",
    category: "Images",
    unit: "100K",
    description: "Total images served to end users",
    probeTable: { type: "ext", dataset: "ext:images" },
    calculator: (db, start, end) => {
      const raw = sumExtTs(db, "ext:images", "sum.requests", start, end);
      return raw === null ? noData() : result(raw, HUNDRED_K);
    },
  },
  {
    key: "images-transformations",
    displayName: "Images \u2013 Transformations",
    category: "Images",
    unit: "1K",
    description: "Image resizing/transformation requests",
    probeTable: { type: "ext", dataset: "ext:image-resizing" },
    calculator: (db, start, end) => {
      const raw = sumExtTs(db, "ext:image-resizing", "sum.requests", start, end);
      if (raw === null) {
        // Fallback: try count metric
        const cnt = sumExtTs(db, "ext:image-resizing", "count", start, end);
        return cnt === null ? noData() : result(cnt, THOUSAND);
      }
      return result(raw, THOUSAND);
    },
  },

  // ===== Zaraz =====
  {
    key: "zaraz-events",
    displayName: "Zaraz \u2013 Events",
    category: "Zaraz",
    unit: "MM",
    description: "Total Zaraz events processed",
    probeTable: { type: "ext", dataset: "ext:zaraz-track" },
    calculator: (db, start, end) => {
      const raw = sumExtTs(db, "ext:zaraz-track", "count", start, end);
      return raw === null ? noData() : result(raw, MM);
    },
  },

  // ===== Stream =====
  {
    key: "stream-minutes-viewed",
    displayName: "Stream \u2013 Minutes Viewed",
    category: "Stream",
    unit: "1K min",
    description: "Total Stream video minutes delivered",
    probeTable: { type: "ext", dataset: "ext:stream" },
    calculator: (db, start, end) => {
      const raw = sumExtTs(db, "ext:stream", "sum.minutesViewed", start, end);
      return raw === null ? noData() : result(raw, THOUSAND);
    },
  },

  // ===== Domains =====
  {
    key: "domains-primary",
    displayName: "Domains \u2013 Primary",
    category: "Domains",
    unit: "zones",
    description: "Number of primary (Enterprise) zones",
    probeTable: { type: "zones" },
    calculator: (db) => {
      // Count zones from the latest collection_log with scope_name present
      // Fall back to counting distinct zone_ids in raw_http_hourly
      const row = db.prepare(
        `SELECT COUNT(DISTINCT zone_id) AS cnt FROM raw_http_hourly`,
      ).get() as { cnt: number } | undefined;
      if (!row || row.cnt === 0) return noData();
      return { value: row.cnt, rawValue: row.cnt, dataAvailable: true };
    },
  },
  {
    key: "acm-domains",
    displayName: "Certificates \u2013 ACM Domains",
    category: "Certificates",
    unit: "zones",
    description: "Number of zones with Advanced Certificate Manager",
    probeTable: { type: "ssl_certs" },
    calculator: (db) => {
      const row = db.prepare(
        `SELECT COUNT(DISTINCT zone_id) AS cnt
         FROM ssl_certificates
         WHERE collected_at = (SELECT MAX(collected_at) FROM ssl_certificates)`,
      ).get() as { cnt: number } | undefined;
      if (!row || row.cnt === 0) return noData();
      return { value: row.cnt, rawValue: row.cnt, dataAvailable: true };
    },
  },

  // ===== Zero Trust (seat-based) =====
  // ZT billing is per-seat/user. Access + Gateway share a single unified seat.
  // Add-ons (RBI, DLP, CASB) are also per-seat.
  {
    key: "zt-seats",
    displayName: "Zero Trust \u2013 Seats",
    category: "Zero Trust",
    unit: "seats",
    description: "Active Zero Trust seats (users with Access or Gateway seat)",
    probeTable: { type: "zt_users" },
    calculator: (db) => {
      // Count unique users who hold an Access or Gateway seat at latest snapshot
      const row = db.prepare(
        `SELECT COUNT(*) AS cnt
         FROM zt_users
         WHERE collected_at = (SELECT MAX(collected_at) FROM zt_users)
           AND (access_seat = 1 OR gateway_seat = 1)`,
      ).get() as { cnt: number } | undefined;
      if (!row || row.cnt === 0) return noData();
      return { value: row.cnt, rawValue: row.cnt, dataAvailable: true };
    },
  },
  {
    key: "zt-access-seats",
    displayName: "Zero Trust \u2013 Access Seats",
    category: "Zero Trust",
    unit: "seats",
    description: "Users with an active Access (ZTNA) seat",
    probeTable: { type: "zt_users" },
    calculator: (db) => {
      const row = db.prepare(
        `SELECT COUNT(*) AS cnt
         FROM zt_users
         WHERE collected_at = (SELECT MAX(collected_at) FROM zt_users)
           AND access_seat = 1`,
      ).get() as { cnt: number } | undefined;
      if (!row || row.cnt === 0) return noData();
      return { value: row.cnt, rawValue: row.cnt, dataAvailable: true };
    },
  },
  {
    key: "zt-gateway-seats",
    displayName: "Zero Trust \u2013 Gateway Seats",
    category: "Zero Trust",
    unit: "seats",
    description: "Users with an active Gateway (SWG) seat",
    probeTable: { type: "zt_users" },
    calculator: (db) => {
      const row = db.prepare(
        `SELECT COUNT(*) AS cnt
         FROM zt_users
         WHERE collected_at = (SELECT MAX(collected_at) FROM zt_users)
           AND gateway_seat = 1`,
      ).get() as { cnt: number } | undefined;
      if (!row || row.cnt === 0) return noData();
      return { value: row.cnt, rawValue: row.cnt, dataAvailable: true };
    },
  },
  {
    key: "zt-rbi-seats",
    displayName: "Zero Trust \u2013 Browser Isolation",
    category: "Zero Trust",
    unit: "seats",
    description: "Unique users with Remote Browser Isolation sessions",
    probeTable: { type: "ext", dataset: "ext:browser-isolation" },
    calculator: (db, start, end) => {
      // RBI is a per-seat add-on. Count unique sessions as a proxy for active users.
      // The browser-isolation dataset tracks session counts, not unique users,
      // so this is an approximation. Falls back to total ZT seat count if no RBI data.
      const row = db.prepare(
        `SELECT COALESCE(SUM(value), 0) AS total, COUNT(*) AS cnt
         FROM raw_ext_ts
         WHERE dataset = 'ext:browser-isolation' AND metric = 'count'
           AND ts >= ? AND ts < ?`,
      ).get(start, end) as { total: number; cnt: number } | undefined;
      if (!row || row.cnt === 0) return noData();
      // Return session count; the committed amount represents licensed seats
      return { value: row.total, rawValue: row.total, dataAvailable: true };
    },
  },
  {
    key: "zt-dlp-seats",
    displayName: "Zero Trust \u2013 DLP",
    category: "Zero Trust",
    unit: "seats",
    description: "Advanced DLP add-on seats (same pool as base ZT seats)",
    probeTable: { type: "zt_users" },
    calculator: (db) => {
      // DLP is licensed per-seat, same count as base ZT seats
      const row = db.prepare(
        `SELECT COUNT(*) AS cnt
         FROM zt_users
         WHERE collected_at = (SELECT MAX(collected_at) FROM zt_users)
           AND (access_seat = 1 OR gateway_seat = 1)`,
      ).get() as { cnt: number } | undefined;
      if (!row || row.cnt === 0) return noData();
      return { value: row.cnt, rawValue: row.cnt, dataAvailable: true };
    },
  },
  {
    key: "zt-casb-seats",
    displayName: "Zero Trust \u2013 CASB",
    category: "Zero Trust",
    unit: "seats",
    description: "API CASB add-on seats (same pool as base ZT seats)",
    probeTable: { type: "zt_users" },
    calculator: (db) => {
      // CASB is licensed per-seat, same count as base ZT seats
      const row = db.prepare(
        `SELECT COUNT(*) AS cnt
         FROM zt_users
         WHERE collected_at = (SELECT MAX(collected_at) FROM zt_users)
           AND (access_seat = 1 OR gateway_seat = 1)`,
      ).get() as { cnt: number } | undefined;
      if (!row || row.cnt === 0) return noData();
      return { value: row.cnt, rawValue: row.cnt, dataAvailable: true };
    },
  },
];

// Indexed by key for fast lookup
export const CATALOG_BY_KEY = new Map<string, ProductCatalogEntry>(
  PRODUCT_CATALOG.map((entry) => [entry.key, entry]),
);

// =============================================================================
// Auto-detection
// =============================================================================

/**
 * Probes local SQLite for datasets with recent data (last 30 days)
 * and returns catalog entries with a `detected` flag.
 */
export function detectAvailableProducts(
  db: Database.Database,
): Array<ProductCatalogEntry & { detected: boolean }> {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;

  // Pre-check which tables/datasets have recent data
  const checks = {
    raw_http: hasRows(db, "SELECT 1 FROM raw_http_hourly WHERE ts >= ? LIMIT 1", thirtyDaysAgo),
    raw_dns: hasRows(db, "SELECT 1 FROM raw_dns_hourly WHERE ts >= ? LIMIT 1", thirtyDaysAgo),
    raw_gw_dns: hasRows(db, "SELECT 1 FROM raw_gw_dns_hourly WHERE ts >= ? LIMIT 1", thirtyDaysAgo),
    dns_records: hasRows(db, "SELECT 1 FROM dns_records LIMIT 1"),
    ssl_certs: hasRows(db, "SELECT 1 FROM ssl_certificates LIMIT 1"),
    zones: hasRows(db, "SELECT 1 FROM raw_http_hourly LIMIT 1"),
    zt_users: hasRows(db, "SELECT 1 FROM zt_users WHERE (access_seat = 1 OR gateway_seat = 1) LIMIT 1"),
  };

  // Check which ext datasets have data
  const extDatasets = new Set<string>();
  try {
    const rows = db.prepare(
      `SELECT DISTINCT dataset FROM raw_ext_ts WHERE ts >= ?`,
    ).all(thirtyDaysAgo) as Array<{ dataset: string }>;
    for (const r of rows) extDatasets.add(r.dataset);
  } catch {
    // Table might not exist
  }

  const extDimDatasets = new Set<string>();
  try {
    const rows = db.prepare(
      `SELECT DISTINCT dataset FROM raw_ext_dim WHERE ts >= ?`,
    ).all(thirtyDaysAgo) as Array<{ dataset: string }>;
    for (const r of rows) extDimDatasets.add(r.dataset);
  } catch {
    // Table might not exist
  }

  return PRODUCT_CATALOG.map((entry) => {
    let detected = false;
    const probe = entry.probeTable;

    switch (probe.type) {
      case "raw_http":
        detected = checks.raw_http;
        break;
      case "raw_dns":
        detected = checks.raw_dns;
        break;
      case "raw_gw_dns":
        detected = checks.raw_gw_dns;
        break;
      case "dns_records":
        detected = checks.dns_records;
        break;
      case "ssl_certs":
        detected = checks.ssl_certs;
        break;
      case "zt_users":
        detected = checks.zt_users;
        break;
      case "zones":
        detected = checks.zones;
        break;
      case "ext":
        detected = extDatasets.has(probe.dataset);
        break;
      case "ext_dim":
        detected = extDimDatasets.has(probe.dataset);
        break;
      case "always":
        // These share a data source with CDN – available if HTTP data exists
        detected = checks.raw_http;
        break;
    }

    return { ...entry, detected };
  });
}

function hasRows(db: Database.Database, sql: string, ...params: unknown[]): boolean {
  try {
    const row = db.prepare(sql).get(...params);
    return row !== undefined;
  } catch {
    return false;
  }
}
