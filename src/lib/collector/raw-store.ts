/**
 * Raw data store – writes fetcher output into raw_* tables.
 *
 * Each store function takes the output of the corresponding raw fetcher
 * and inserts it into the appropriate raw tables using INSERT OR REPLACE
 * for natural deduplication via PRIMARY KEY constraints.
 *
 * All inserts are wrapped in a single transaction per scope for atomicity.
 */

import { getDb } from "@/lib/db";
import type Database from "better-sqlite3";
import type {
  RawZoneData,
  RawAccountData,
} from "./raw-fetchers";


// =============================================================================
// Zone data store
// =============================================================================

/**
 * Store all raw zone data in a single transaction.
 */
export function storeRawZoneData(zoneId: string, data: RawZoneData): void {
  const db = getDb();
  if (!db) return;

  db.transaction(() => {
    if (data.http) {
      storeRawHttpHourly(db, zoneId, data.http.hourly);
      storeRawHttpDim(db, zoneId, data.http.dims);
    }
    if (data.httpOverview) {
      storeRawHttpOverview(db, zoneId, data.httpOverview.hourly);
    }
    if (data.firewall) {
      storeRawFwHourly(db, zoneId, data.firewall.hourly);
      storeRawFwDim(db, zoneId, data.firewall.dims);
    }
    if (data.dns) {
      storeRawDnsHourly(db, zoneId, data.dns.hourly);
      storeRawDnsDim(db, zoneId, data.dns.dims);
    }
    if (data.health) {
      storeRawHealthEvents(db, zoneId, data.health.events);
    }
  })();
}


function storeRawHttpHourly(
  db: Database.Database,
  zoneId: string,
  rows: RawZoneData["http"] extends null ? never : NonNullable<RawZoneData["http"]>["hourly"],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_http_hourly (
      zone_id, ts, requests, bytes, cached_requests, cached_bytes, encrypted_requests,
      status_1xx, status_2xx, status_3xx, status_4xx, status_5xx,
      ttfb_avg, ttfb_p50, ttfb_p95, ttfb_p99,
      origin_time_avg, origin_time_p50, origin_time_p95, origin_time_p99
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const r of rows) {
    stmt.run(
      zoneId, r.ts, r.requests, r.bytes, r.cached_requests, r.cached_bytes, r.encrypted_requests,
      r.status_1xx, r.status_2xx, r.status_3xx, r.status_4xx, r.status_5xx,
      r.ttfb_avg, r.ttfb_p50, r.ttfb_p95, r.ttfb_p99,
      r.origin_time_avg, r.origin_time_p50, r.origin_time_p95, r.origin_time_p99,
    );
  }
}


function storeRawHttpDim(
  db: Database.Database,
  zoneId: string,
  rows: NonNullable<RawZoneData["http"]>["dims"],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_http_dim (zone_id, ts, dim, key, requests, bytes, ttfb_avg, origin_avg)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const r of rows) {
    stmt.run(zoneId, r.ts, r.dim, r.key, r.requests, r.bytes, r.ttfb_avg, r.origin_avg);
  }
}


function storeRawHttpOverview(
  db: Database.Database,
  zoneId: string,
  rows: NonNullable<RawZoneData["httpOverview"]>["hourly"],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_http_overview_hourly (zone_id, ts, requests, encrypted_requests)
    VALUES (?, ?, ?, ?)
  `);

  for (const r of rows) {
    stmt.run(zoneId, r.ts, r.requests, r.encrypted_requests);
  }
}


function storeRawFwHourly(
  db: Database.Database,
  zoneId: string,
  rows: NonNullable<RawZoneData["firewall"]>["hourly"],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_fw_hourly (
      zone_id, ts, total, blocked, challenged, managed_challenged,
      js_challenged, challenge_solved, logged, skipped
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const r of rows) {
    stmt.run(
      zoneId, r.ts, r.total, r.blocked, r.challenged, r.managed_challenged,
      r.js_challenged, r.challenge_solved, r.logged, r.skipped,
    );
  }
}


function storeRawFwDim(
  db: Database.Database,
  zoneId: string,
  rows: NonNullable<RawZoneData["firewall"]>["dims"],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_fw_dim (zone_id, ts, dim, key, events, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const r of rows) {
    stmt.run(zoneId, r.ts, r.dim, r.key, r.events, r.detail);
  }
}


function storeRawDnsHourly(
  db: Database.Database,
  zoneId: string,
  rows: NonNullable<RawZoneData["dns"]>["hourly"],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_dns_hourly (zone_id, ts, queries)
    VALUES (?, ?, ?)
  `);

  for (const r of rows) {
    stmt.run(zoneId, r.ts, r.queries);
  }
}


function storeRawDnsDim(
  db: Database.Database,
  zoneId: string,
  rows: NonNullable<RawZoneData["dns"]>["dims"],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_dns_dim (zone_id, ts, dim, key, queries)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const r of rows) {
    stmt.run(zoneId, r.ts, r.dim, r.key, r.queries);
  }
}


function storeRawHealthEvents(
  db: Database.Database,
  zoneId: string,
  rows: NonNullable<RawZoneData["health"]>["events"],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_health_events (zone_id, ts, name, origin_ip, status, response_status, rtt_ms, failure_reason, region)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const r of rows) {
    stmt.run(zoneId, r.ts, r.name, r.origin_ip, r.status, r.response_status, r.rtt_ms, r.failure_reason, r.region);
  }
}


// =============================================================================
// Account data store
// =============================================================================

/**
 * Store all raw account data in a single transaction.
 */
export function storeRawAccountData(accountId: string, data: RawAccountData): void {
  const db = getDb();
  if (!db) return;

  db.transaction(() => {
    if (data.gwDns) {
      storeRawGwDnsHourly(db, accountId, data.gwDns.hourly);
      storeRawGwDnsDim(db, accountId, data.gwDns.dims);
    }
    if (data.gwNet) {
      storeRawGwNetHourly(db, accountId, data.gwNet.hourly);
      storeRawGwNetDim(db, accountId, data.gwNet.dims);
    }
    if (data.gwHttp) {
      storeRawGwHttpHourly(db, accountId, data.gwHttp.hourly);
      storeRawGwHttpDim(db, accountId, data.gwHttp.dims);
    }
    if (data.access) {
      storeRawAccessDaily(db, accountId, data.access.daily);
      storeRawAccessDim(db, accountId, data.access.dims);
    }
    if (data.dosd) {
      storeRawDosdAttacks(db, accountId, data.dosd.attacks);
    }
  })();
}


function storeRawGwDnsHourly(
  db: Database.Database,
  accountId: string,
  rows: NonNullable<RawAccountData["gwDns"]>["hourly"],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_gw_dns_hourly (account_id, ts, total, blocked, allowed)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const r of rows) {
    stmt.run(accountId, r.ts, r.total, r.blocked, r.allowed);
  }
}


function storeRawGwDnsDim(
  db: Database.Database,
  accountId: string,
  rows: NonNullable<RawAccountData["gwDns"]>["dims"],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_gw_dns_dim (account_id, ts, dim, key, queries, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const r of rows) {
    stmt.run(accountId, r.ts, r.dim, r.key, r.queries, r.detail);
  }
}


function storeRawGwNetHourly(
  db: Database.Database,
  accountId: string,
  rows: NonNullable<RawAccountData["gwNet"]>["hourly"],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_gw_net_hourly (account_id, ts, allowed, blocked)
    VALUES (?, ?, ?, ?)
  `);

  for (const r of rows) {
    stmt.run(accountId, r.ts, r.allowed, r.blocked);
  }
}


function storeRawGwNetDim(
  db: Database.Database,
  accountId: string,
  rows: NonNullable<RawAccountData["gwNet"]>["dims"],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_gw_net_dim (account_id, ts, dim, key, sessions, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const r of rows) {
    stmt.run(accountId, r.ts, r.dim, r.key, r.sessions, r.detail);
  }
}


function storeRawGwHttpHourly(
  db: Database.Database,
  accountId: string,
  rows: NonNullable<RawAccountData["gwHttp"]>["hourly"],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_gw_http_hourly (account_id, ts, total)
    VALUES (?, ?, ?)
  `);

  for (const r of rows) {
    stmt.run(accountId, r.ts, r.total);
  }
}


function storeRawGwHttpDim(
  db: Database.Database,
  accountId: string,
  rows: NonNullable<RawAccountData["gwHttp"]>["dims"],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_gw_http_dim (account_id, ts, dim, key, requests)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const r of rows) {
    stmt.run(accountId, r.ts, r.dim, r.key, r.requests);
  }
}


function storeRawAccessDaily(
  db: Database.Database,
  accountId: string,
  rows: NonNullable<RawAccountData["access"]>["daily"],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_access_daily (account_id, ts, successful, failed)
    VALUES (?, ?, ?, ?)
  `);

  for (const r of rows) {
    stmt.run(accountId, r.ts, r.successful, r.failed);
  }
}


function storeRawAccessDim(
  db: Database.Database,
  accountId: string,
  rows: NonNullable<RawAccountData["access"]>["dims"],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_access_dim (account_id, ts, dim, key, logins, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const r of rows) {
    stmt.run(accountId, r.ts, r.dim, r.key, r.logins, r.detail);
  }
}


function storeRawDosdAttacks(
  db: Database.Database,
  accountId: string,
  rows: NonNullable<RawAccountData["dosd"]>["attacks"],
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO raw_dosd_attacks (
      account_id, attack_id, attack_type, attack_vector, ip_protocol,
      destination_port, mitigation_type, packets, bits,
      dropped_packets, dropped_bits, start_time, end_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const r of rows) {
    stmt.run(
      accountId, r.attack_id, r.attack_type, r.attack_vector, r.ip_protocol,
      r.destination_port, r.mitigation_type, r.packets, r.bits,
      r.dropped_packets, r.dropped_bits, r.start_time, r.end_time,
    );
  }
}


// =============================================================================
// Last timestamp queries (for incremental sync)
// =============================================================================

/** Dataset keys used by the collector for incremental sync. */
export type DatasetKey =
  | "http" | "http_overview" | "firewall" | "dns" | "health"
  | "gw-dns" | "gw-net" | "gw-http" | "access" | "dosd";

const LAST_TS_QUERIES: Record<DatasetKey, { query: string; scopeCol: string }> = {
  http:          { query: "SELECT MAX(ts) as max_ts FROM raw_http_hourly WHERE zone_id = ?", scopeCol: "zone_id" },
  http_overview: { query: "SELECT MAX(ts) as max_ts FROM raw_http_overview_hourly WHERE zone_id = ?", scopeCol: "zone_id" },
  firewall:      { query: "SELECT MAX(ts) as max_ts FROM raw_fw_hourly WHERE zone_id = ?", scopeCol: "zone_id" },
  dns:           { query: "SELECT MAX(ts) as max_ts FROM raw_dns_hourly WHERE zone_id = ?", scopeCol: "zone_id" },
  health:        { query: "SELECT MAX(ts) as max_ts FROM raw_health_events WHERE zone_id = ?", scopeCol: "zone_id" },
  "gw-dns":      { query: "SELECT MAX(ts) as max_ts FROM raw_gw_dns_hourly WHERE account_id = ?", scopeCol: "account_id" },
  "gw-net":      { query: "SELECT MAX(ts) as max_ts FROM raw_gw_net_hourly WHERE account_id = ?", scopeCol: "account_id" },
  "gw-http":     { query: "SELECT MAX(ts) as max_ts FROM raw_gw_http_hourly WHERE account_id = ?", scopeCol: "account_id" },
  access:        { query: "SELECT MAX(ts) as max_ts FROM raw_access_daily WHERE account_id = ?", scopeCol: "account_id" },
  dosd:          { query: "SELECT MAX(start_time) as max_ts FROM raw_dosd_attacks WHERE account_id = ?", scopeCol: "account_id" },
};

/**
 * Get the most recent timestamp for a raw dataset.
 * Used by the collector for incremental sync.
 */
export function getRawLastTimestamp(scopeId: string, dataset: DatasetKey): number | null {
  const db = getDb();
  if (!db) return null;

  const entry = LAST_TS_QUERIES[dataset];
  if (!entry) return null;

  const row = db.prepare(entry.query).get(scopeId) as { max_ts: number | null } | undefined;
  return row?.max_ts ?? null;
}

/**
 * Get the earliest last timestamp across all zone datasets for a given zone.
 * This determines the "since" for incremental fetching.
 */
export function getZoneLastTimestamp(zoneId: string): number | null {
  const datasets: DatasetKey[] = ["http", "http_overview", "firewall", "dns", "health"];
  let minTs: number | null = null;

  for (const ds of datasets) {
    const ts = getRawLastTimestamp(zoneId, ds);
    if (ts !== null) {
      if (minTs === null || ts < minTs) minTs = ts;
    }
  }

  return minTs;
}

/**
 * Get the earliest last timestamp across all account datasets for a given account.
 */
export function getAccountLastTimestamp(accountId: string): number | null {
  const datasets: DatasetKey[] = ["gw-dns", "gw-net", "gw-http", "access", "dosd"];
  let minTs: number | null = null;

  for (const ds of datasets) {
    const ts = getRawLastTimestamp(accountId, ds);
    if (ts !== null) {
      if (minTs === null || ts < minTs) minTs = ts;
    }
  }

  return minTs;
}
