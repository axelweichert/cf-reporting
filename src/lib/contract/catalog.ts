/**
 * Contract Usage – Product Catalog
 *
 * Maps each known Cloudflare enterprise line item to:
 * - display metadata (name, category, unit, description)
 * - a probe target for auto-detection
 * - a calculator function that derives monthly usage from raw SQLite tables
 * - an optional zone-breakdown function for drill-down
 *
 * All calculator functions receive (db, monthStart, monthEnd, accountId?)
 * where timestamps are unix epoch seconds in UTC.
 *
 * Zone-scoped calculators join zone_accounts to filter by account_id
 * when an account is specified on the line item.
 * Account-scoped calculators filter by scope_id = accountId directly.
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

/**
 * Account zone filter clause.
 * When accountId is set, restricts to zones belonging to that account.
 * When accountId is not set, no filtering (all zones).
 */
function accountZoneFilter(accountId?: string): string {
  if (!accountId) return "";
  return ` AND zone_id IN (SELECT zone_id FROM zone_accounts WHERE account_id = '${accountId}')`;
}

/** List of zone_ids for a given account (all plans). */
function getAccountZoneIds(db: Database.Database, accountId?: string): Array<{ zone_id: string; zone_name: string }> {
  if (!accountId) {
    return db.prepare("SELECT zone_id, zone_name FROM zone_accounts").all() as Array<{ zone_id: string; zone_name: string }>;
  }
  return db.prepare(
    "SELECT zone_id, zone_name FROM zone_accounts WHERE account_id = ?",
  ).all(accountId) as Array<{ zone_id: string; zone_name: string }>;
}

/** SUM a column from raw_http_hourly for enterprise zones of an account. */
function sumHttpColumn(
  db: Database.Database, column: string, start: number, end: number, accountId?: string,
): number | null {
  const filter = accountZoneFilter(accountId);
  const row = db.prepare(
    `SELECT COALESCE(SUM(${column}), 0) AS total, COUNT(*) AS cnt
     FROM raw_http_hourly WHERE ts >= ? AND ts < ?${filter}`,
  ).get(start, end) as { total: number; cnt: number } | undefined;
  if (!row || row.cnt === 0) return null;
  return row.total;
}

/** Per-zone breakdown of an HTTP column for enterprise zones. */
function breakdownHttpColumn(
  db: Database.Database, column: string, start: number, end: number, accountId?: string,
): Array<{ zoneId: string; zoneName: string; usageValue: number }> {
  const zones = getAccountZoneIds(db, accountId);
  if (zones.length === 0) return [];

  return zones.map((z) => {
    const row = db.prepare(
      `SELECT COALESCE(SUM(${column}), 0) AS total
       FROM raw_http_hourly WHERE zone_id = ? AND ts >= ? AND ts < ?`,
    ).get(z.zone_id, start, end) as { total: number };
    return { zoneId: z.zone_id, zoneName: z.zone_name, usageValue: row.total };
  }).filter((r) => r.usageValue > 0);
}

/** SUM queries from raw_dns_hourly for enterprise zones. */
function sumDnsQueries(
  db: Database.Database, start: number, end: number, accountId?: string,
): number | null {
  const filter = accountZoneFilter(accountId);
  const row = db.prepare(
    `SELECT COALESCE(SUM(queries), 0) AS total, COUNT(*) AS cnt
     FROM raw_dns_hourly WHERE ts >= ? AND ts < ?${filter}`,
  ).get(start, end) as { total: number; cnt: number } | undefined;
  if (!row || row.cnt === 0) return null;
  return row.total;
}

/** Per-zone DNS breakdown. */
function breakdownDnsQueries(
  db: Database.Database, start: number, end: number, accountId?: string,
): Array<{ zoneId: string; zoneName: string; usageValue: number }> {
  const zones = getAccountZoneIds(db, accountId);
  return zones.map((z) => {
    const row = db.prepare(
      `SELECT COALESCE(SUM(queries), 0) AS total
       FROM raw_dns_hourly WHERE zone_id = ? AND ts >= ? AND ts < ?`,
    ).get(z.zone_id, start, end) as { total: number };
    return { zoneId: z.zone_id, zoneName: z.zone_name, usageValue: row.total };
  }).filter((r) => r.usageValue > 0);
}

/** SUM a metric from raw_ext_ts for a given dataset, filtered by account. */
function sumExtTs(
  db: Database.Database, dataset: string, metric: string, start: number, end: number, accountId?: string,
): number | null {
  const acctFilter = accountId ? ` AND scope_id = '${accountId}'` : "";
  const row = db.prepare(
    `SELECT COALESCE(SUM(value), 0) AS total, COUNT(*) AS cnt
     FROM raw_ext_ts WHERE dataset = ? AND metric = ? AND ts >= ? AND ts < ?${acctFilter}`,
  ).get(dataset, metric, start, end) as { total: number; cnt: number } | undefined;
  if (!row || row.cnt === 0) return null;
  return row.total;
}

/** MAX of a metric from raw_ext_ts. */
function maxExtTs(
  db: Database.Database, dataset: string, metric: string, start: number, end: number, accountId?: string,
): number | null {
  const acctFilter = accountId ? ` AND scope_id = '${accountId}'` : "";
  const row = db.prepare(
    `SELECT COALESCE(MAX(value), 0) AS peak, COUNT(*) AS cnt
     FROM raw_ext_ts WHERE dataset = ? AND metric = ? AND ts >= ? AND ts < ?${acctFilter}`,
  ).get(dataset, metric, start, end) as { peak: number; cnt: number } | undefined;
  if (!row || row.cnt === 0) return null;
  return row.peak;
}

/** Average of daily MAX values for a storage metric. */
function avgDailyMaxExtTs(
  db: Database.Database, dataset: string, metric: string, start: number, end: number, accountId?: string,
): number | null {
  const acctFilter = accountId ? ` AND scope_id = '${accountId}'` : "";
  const rows = db.prepare(
    `SELECT MAX(value) AS daily_max
     FROM raw_ext_ts
     WHERE dataset = ? AND metric = ? AND ts >= ? AND ts < ?${acctFilter}
     GROUP BY (ts / 86400)`,
  ).all(dataset, metric, start, end) as Array<{ daily_max: number }>;
  if (rows.length === 0) return null;
  const sum = rows.reduce((acc, r) => acc + r.daily_max, 0);
  return sum / rows.length;
}

/** SUM from raw_ext_dim filtered by dimension key values. */
function sumExtDimFiltered(
  db: Database.Database, dataset: string, dimName: string,
  keys: string[], metric: string, start: number, end: number, accountId?: string,
): number | null {
  const placeholders = keys.map(() => "?").join(",");
  const acctFilter = accountId ? ` AND scope_id = '${accountId}'` : "";
  const row = db.prepare(
    `SELECT COALESCE(SUM(value), 0) AS total, COUNT(*) AS cnt
     FROM raw_ext_dim
     WHERE dataset = ? AND dim = ? AND key IN (${placeholders})
       AND metric = ? AND ts >= ? AND ts < ?${acctFilter}`,
  ).get(dataset, dimName, ...keys, metric, start, end) as { total: number; cnt: number } | undefined;
  if (!row || row.cnt === 0) return null;
  return row.total;
}

// =============================================================================
// Product Catalog
// =============================================================================

const R2_CLASS_A_ACTIONS = [
  "PutObject", "CopyObject", "ListBucket", "ListMultipartUploads",
  "CreateMultipartUpload", "CompleteMultipartUpload", "AbortMultipartUpload",
  "UploadPart", "UploadPartCopy", "DeleteObject", "DeleteObjects",
];

const R2_CLASS_B_ACTIONS = [
  "GetObject", "HeadObject", "HeadBucket",
];

// Helper to build HTTP-based entries (CDN, WAF, Bot, RL all share the same data)
function httpEntry(
  key: string, displayName: string, category: string, unit: string, description: string,
  column: string, divisor: number, probeAlways = false,
): ProductCatalogEntry {
  return {
    key, displayName, category, unit, description,
    probeTable: probeAlways ? { type: "always" as const } : { type: "raw_http" as const },
    zoneScoped: true,
    calculator: (db, start, end, accountId) => {
      const raw = sumHttpColumn(db, column, start, end, accountId);
      return raw === null ? noData() : result(raw, divisor);
    },
    zoneBreakdown: (db, start, end, accountId) =>
      breakdownHttpColumn(db, column, start, end, accountId).map((z) => ({
        ...z, usageValue: Math.round((z.usageValue / divisor) * 100) / 100,
      })),
  };
}

export const PRODUCT_CATALOG: ProductCatalogEntry[] = [
  // ===== CDN =====
  httpEntry("cdn-data-transfer", "CDN \u2013 Data Transfer", "CDN", "TB",
    "Total edge data transfer (edgeResponseBytes) across enterprise zones", "bytes", TB),
  httpEntry("cdn-requests", "CDN \u2013 Requests", "CDN", "MM",
    "Total HTTP requests across enterprise zones", "requests", MM),

  // ===== WAF =====
  httpEntry("waf-data-transfer", "WAF \u2013 Data Transfer", "WAF", "TB",
    "WAF-processed data transfer (same as CDN \u2013 WAF inspects all traffic)", "bytes", TB, true),
  httpEntry("waf-requests", "WAF \u2013 Requests", "WAF", "MM",
    "WAF-processed requests (same as CDN \u2013 WAF inspects all traffic)", "requests", MM, true),

  // ===== Bot Management =====
  httpEntry("bot-mgmt-requests", "Bot Management \u2013 Requests", "Bot Management", "MM",
    "Requests evaluated by Bot Management (all HTTP traffic)", "requests", MM, true),

  // ===== Rate Limiting =====
  httpEntry("rate-limiting-requests", "Rate Limiting \u2013 Requests", "Rate Limiting", "MM",
    "Requests evaluated by Rate Limiting rules (all HTTP traffic)", "requests", MM, true),

  // ===== Foundation DNS =====
  {
    key: "dns-queries",
    displayName: "Foundation DNS \u2013 Queries",
    category: "DNS",
    unit: "MM",
    description: "Total authoritative DNS queries across enterprise zones",
    probeTable: { type: "raw_dns" },
    zoneScoped: true,
    calculator: (db, start, end, accountId) => {
      const raw = sumDnsQueries(db, start, end, accountId);
      return raw === null ? noData() : result(raw, MM);
    },
    zoneBreakdown: (db, start, end, accountId) =>
      breakdownDnsQueries(db, start, end, accountId).map((z) => ({
        ...z, usageValue: Math.round((z.usageValue / MM) * 100) / 100,
      })),
  },
  {
    key: "dns-records",
    displayName: "Foundation DNS \u2013 Records",
    category: "DNS",
    unit: "10K records",
    description: "Total DNS records across enterprise zones (latest snapshot)",
    probeTable: { type: "dns_records" },
    zoneScoped: true,
    calculator: (db, _start, _end, accountId) => {
      const filter = accountZoneFilter(accountId);
      const row = db.prepare(
        `SELECT COUNT(DISTINCT record_id) AS cnt
         FROM dns_records
         WHERE collected_at = (SELECT MAX(collected_at) FROM dns_records)${filter}`,
      ).get() as { cnt: number } | undefined;
      if (!row || row.cnt === 0) return noData();
      return result(row.cnt, TEN_K);
    },
    zoneBreakdown: (db, _start, _end, accountId) => {
      const zones = getAccountZoneIds(db, accountId);
      return zones.map((z) => {
        const row = db.prepare(
          `SELECT COUNT(DISTINCT record_id) AS cnt FROM dns_records
           WHERE zone_id = ? AND collected_at = (SELECT MAX(collected_at) FROM dns_records WHERE zone_id = ?)`,
        ).get(z.zone_id, z.zone_id) as { cnt: number };
        return { zoneId: z.zone_id, zoneName: z.zone_name, usageValue: Math.round((row.cnt / TEN_K) * 100) / 100 };
      }).filter((r) => r.usageValue > 0);
    },
  },

  // ===== Workers (account-scoped) =====
  {
    key: "workers-requests",
    displayName: "Workers \u2013 Requests",
    category: "Workers",
    unit: "MM",
    description: "Total Worker invocations across all scripts",
    probeTable: { type: "ext", dataset: "ext:workers" },
    zoneScoped: false,
    calculator: (db, start, end, accountId) => {
      const raw = sumExtTs(db, "ext:workers", "sum.requests", start, end, accountId);
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
    zoneScoped: false,
    calculator: (db, start, end, accountId) => {
      const raw = sumExtTs(db, "ext:workers", "sum.cpuTimeUs", start, end, accountId);
      if (raw === null) return noData();
      const ms = raw / THOUSAND;
      return result(ms, MM);
    },
  },

  // ===== R2 (account-scoped) =====
  {
    key: "r2-storage",
    displayName: "R2 \u2013 Storage",
    category: "R2",
    unit: "TB",
    description: "Average daily peak R2 storage (GB-month billing model)",
    probeTable: { type: "ext", dataset: "ext:r2-storage" },
    zoneScoped: false,
    calculator: (db, start, end, accountId) => {
      const raw = avgDailyMaxExtTs(db, "ext:r2-storage", "max.payloadSize", start, end, accountId);
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
    zoneScoped: false,
    calculator: (db, start, end, accountId) => {
      const raw = sumExtDimFiltered(db, "ext:r2-ops", "actionType", R2_CLASS_A_ACTIONS, "sum.requests", start, end, accountId);
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
    zoneScoped: false,
    calculator: (db, start, end, accountId) => {
      const raw = sumExtDimFiltered(db, "ext:r2-ops", "actionType", R2_CLASS_B_ACTIONS, "sum.requests", start, end, accountId);
      return raw === null ? noData() : result(raw, MM);
    },
  },

  // ===== KV (account-scoped) =====
  {
    key: "kv-reads",
    displayName: "Workers KV \u2013 Reads",
    category: "KV",
    unit: "MM",
    description: "KV read operations",
    probeTable: { type: "ext_dim", dataset: "ext:kv-ops" },
    zoneScoped: false,
    calculator: (db, start, end, accountId) => {
      const raw = sumExtDimFiltered(db, "ext:kv-ops", "actionType", ["read"], "sum.requests", start, end, accountId);
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
    zoneScoped: false,
    calculator: (db, start, end, accountId) => {
      const raw = sumExtDimFiltered(db, "ext:kv-ops", "actionType", ["write", "delete", "list"], "sum.requests", start, end, accountId);
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
    zoneScoped: false,
    calculator: (db, start, end, accountId) => {
      const raw = maxExtTs(db, "ext:kv-storage", "max.byteCount", start, end, accountId);
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
    zoneScoped: false,
    calculator: (db, start, end, accountId) => {
      const raw = sumExtTs(db, "ext:images", "sum.requests", start, end, accountId);
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
    zoneScoped: true,
    calculator: (db, start, end, accountId) => {
      // image-resizing is zone-scoped in ext datasets
      const filter = accountId
        ? ` AND scope_id IN (SELECT zone_id FROM zone_accounts WHERE account_id = '${accountId}')`
        : "";
      const row = db.prepare(
        `SELECT COALESCE(SUM(value), 0) AS total, COUNT(*) AS cnt
         FROM raw_ext_ts WHERE dataset = 'ext:image-resizing' AND metric = 'sum.requests'
           AND ts >= ? AND ts < ?${filter}`,
      ).get(start, end) as { total: number; cnt: number } | undefined;
      if (!row || row.cnt === 0) {
        const cnt = db.prepare(
          `SELECT COALESCE(SUM(value), 0) AS total, COUNT(*) AS cnt
           FROM raw_ext_ts WHERE dataset = 'ext:image-resizing' AND metric = 'count'
             AND ts >= ? AND ts < ?${filter}`,
        ).get(start, end) as { total: number; cnt: number } | undefined;
        return (!cnt || cnt.cnt === 0) ? noData() : result(cnt.total, THOUSAND);
      }
      return result(row.total, THOUSAND);
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
    zoneScoped: true,
    calculator: (db, start, end, accountId) => {
      const filter = accountId
        ? ` AND scope_id IN (SELECT zone_id FROM zone_accounts WHERE account_id = '${accountId}')`
        : "";
      const row = db.prepare(
        `SELECT COALESCE(SUM(value), 0) AS total, COUNT(*) AS cnt
         FROM raw_ext_ts WHERE dataset = 'ext:zaraz-track' AND metric = 'count'
           AND ts >= ? AND ts < ?${filter}`,
      ).get(start, end) as { total: number; cnt: number } | undefined;
      if (!row || row.cnt === 0) return noData();
      return result(row.total, MM);
    },
  },

  // ===== Stream (account-scoped) =====
  {
    key: "stream-minutes-viewed",
    displayName: "Stream \u2013 Minutes Viewed",
    category: "Stream",
    unit: "1K min",
    description: "Total Stream video minutes delivered",
    probeTable: { type: "ext", dataset: "ext:stream" },
    zoneScoped: false,
    calculator: (db, start, end, accountId) => {
      const raw = sumExtTs(db, "ext:stream", "sum.minutesViewed", start, end, accountId);
      return raw === null ? noData() : result(raw, THOUSAND);
    },
  },

  // ===== Domains =====
  {
    key: "domains-primary",
    displayName: "Domains \u2013 Primary",
    category: "Domains",
    unit: "zones",
    description: "Number of primary zones in the account",
    probeTable: { type: "zones" },
    zoneScoped: true,
    calculator: (db, _start, _end, accountId) => {
      const acctFilter = accountId ? " WHERE account_id = ?" : "";
      const params = accountId ? [accountId] : [];
      const row = db.prepare(
        `SELECT COUNT(*) AS cnt FROM zone_accounts${acctFilter}`,
      ).get(...params) as { cnt: number } | undefined;
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
    zoneScoped: true,
    calculator: (db, _start, _end, accountId) => {
      const filter = accountZoneFilter(accountId);
      const row = db.prepare(
        `SELECT COUNT(DISTINCT zone_id) AS cnt
         FROM ssl_certificates
         WHERE collected_at = (SELECT MAX(collected_at) FROM ssl_certificates)${filter}`,
      ).get() as { cnt: number } | undefined;
      if (!row || row.cnt === 0) return noData();
      return { value: row.cnt, rawValue: row.cnt, dataAvailable: true };
    },
  },

  // ===== Zero Trust (account-scoped, seat-based) =====
  {
    key: "zt-seats",
    displayName: "Zero Trust \u2013 Seats",
    category: "Zero Trust",
    unit: "seats",
    description: "Active Zero Trust seats (users with Access or Gateway seat)",
    probeTable: { type: "zt_users" },
    zoneScoped: false,
    calculator: (db, _start, _end, accountId) => {
      const acctFilter = accountId ? " AND account_id = ?" : "";
      const params = accountId ? [accountId] : [];
      const row = db.prepare(
        `SELECT COUNT(*) AS cnt FROM zt_users
         WHERE collected_at = (SELECT MAX(collected_at) FROM zt_users)
           AND (access_seat = 1 OR gateway_seat = 1)${acctFilter}`,
      ).get(...params) as { cnt: number } | undefined;
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
    zoneScoped: false,
    calculator: (db, _start, _end, accountId) => {
      const acctFilter = accountId ? " AND account_id = ?" : "";
      const params = accountId ? [accountId] : [];
      const row = db.prepare(
        `SELECT COUNT(*) AS cnt FROM zt_users
         WHERE collected_at = (SELECT MAX(collected_at) FROM zt_users)
           AND access_seat = 1${acctFilter}`,
      ).get(...params) as { cnt: number } | undefined;
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
    zoneScoped: false,
    calculator: (db, _start, _end, accountId) => {
      const acctFilter = accountId ? " AND account_id = ?" : "";
      const params = accountId ? [accountId] : [];
      const row = db.prepare(
        `SELECT COUNT(*) AS cnt FROM zt_users
         WHERE collected_at = (SELECT MAX(collected_at) FROM zt_users)
           AND gateway_seat = 1${acctFilter}`,
      ).get(...params) as { cnt: number } | undefined;
      if (!row || row.cnt === 0) return noData();
      return { value: row.cnt, rawValue: row.cnt, dataAvailable: true };
    },
  },
  {
    key: "zt-rbi-seats",
    displayName: "Zero Trust \u2013 Browser Isolation",
    category: "Zero Trust",
    unit: "seats",
    description: "Remote Browser Isolation session count",
    probeTable: { type: "ext", dataset: "ext:browser-isolation" },
    zoneScoped: false,
    calculator: (db, start, end, accountId) => {
      const raw = sumExtTs(db, "ext:browser-isolation", "count", start, end, accountId);
      if (raw === null) return noData();
      return { value: raw, rawValue: raw, dataAvailable: true };
    },
  },
  {
    key: "zt-dlp-seats",
    displayName: "Zero Trust \u2013 DLP",
    category: "Zero Trust",
    unit: "seats",
    description: "Advanced DLP add-on seats (same pool as base ZT seats)",
    probeTable: { type: "zt_users" },
    zoneScoped: false,
    calculator: (db, _start, _end, accountId) => {
      const acctFilter = accountId ? " AND account_id = ?" : "";
      const params = accountId ? [accountId] : [];
      const row = db.prepare(
        `SELECT COUNT(*) AS cnt FROM zt_users
         WHERE collected_at = (SELECT MAX(collected_at) FROM zt_users)
           AND (access_seat = 1 OR gateway_seat = 1)${acctFilter}`,
      ).get(...params) as { cnt: number } | undefined;
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
    zoneScoped: false,
    calculator: (db, _start, _end, accountId) => {
      const acctFilter = accountId ? " AND account_id = ?" : "";
      const params = accountId ? [accountId] : [];
      const row = db.prepare(
        `SELECT COUNT(*) AS cnt FROM zt_users
         WHERE collected_at = (SELECT MAX(collected_at) FROM zt_users)
           AND (access_seat = 1 OR gateway_seat = 1)${acctFilter}`,
      ).get(...params) as { cnt: number } | undefined;
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

export function detectAvailableProducts(
  db: Database.Database,
): Array<ProductCatalogEntry & { detected: boolean }> {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;

  const checks = {
    raw_http: hasRows(db, "SELECT 1 FROM raw_http_hourly WHERE ts >= ? LIMIT 1", thirtyDaysAgo),
    raw_dns: hasRows(db, "SELECT 1 FROM raw_dns_hourly WHERE ts >= ? LIMIT 1", thirtyDaysAgo),
    raw_gw_dns: hasRows(db, "SELECT 1 FROM raw_gw_dns_hourly WHERE ts >= ? LIMIT 1", thirtyDaysAgo),
    dns_records: hasRows(db, "SELECT 1 FROM dns_records LIMIT 1"),
    ssl_certs: hasRows(db, "SELECT 1 FROM ssl_certificates LIMIT 1"),
    zones: hasRows(db, "SELECT 1 FROM zone_accounts LIMIT 1"),
    zt_users: hasRows(db, "SELECT 1 FROM zt_users WHERE (access_seat = 1 OR gateway_seat = 1) LIMIT 1"),
  };

  const extDatasets = new Set<string>();
  try {
    const rows = db.prepare(
      `SELECT DISTINCT dataset FROM raw_ext_ts WHERE ts >= ?`,
    ).all(thirtyDaysAgo) as Array<{ dataset: string }>;
    for (const r of rows) extDatasets.add(r.dataset);
  } catch { /* table might not exist */ }

  const extDimDatasets = new Set<string>();
  try {
    const rows = db.prepare(
      `SELECT DISTINCT dataset FROM raw_ext_dim WHERE ts >= ?`,
    ).all(thirtyDaysAgo) as Array<{ dataset: string }>;
    for (const r of rows) extDimDatasets.add(r.dataset);
  } catch { /* table might not exist */ }

  return PRODUCT_CATALOG.map((entry) => {
    let detected = false;
    const probe = entry.probeTable;

    switch (probe.type) {
      case "raw_http": detected = checks.raw_http; break;
      case "raw_dns": detected = checks.raw_dns; break;
      case "raw_gw_dns": detected = checks.raw_gw_dns; break;
      case "dns_records": detected = checks.dns_records; break;
      case "ssl_certs": detected = checks.ssl_certs; break;
      case "zones": detected = checks.zones; break;
      case "zt_users": detected = checks.zt_users; break;
      case "ext": detected = extDatasets.has(probe.dataset); break;
      case "ext_dim": detected = extDimDatasets.has(probe.dataset); break;
      case "always": detected = checks.raw_http; break;
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
