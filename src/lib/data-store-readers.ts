/**
 * Data store reader functions.
 *
 * Each function reads from the normalized SQLite tables and reconstructs
 * the exact typed shape that the browser query module returns.
 *
 * All reader functions take (scopeId, fromTs, toTs) where fromTs/toTs
 * are unix epoch seconds and return the typed data shape or null if no
 * data is available.
 */

import { getDb } from "@/lib/db";
import type Database from "better-sqlite3";

import type { ExecutiveData } from "@/lib/queries/executive";
import type { SecurityEmailData } from "@/lib/email/report-data";
import type { TrafficData } from "@/lib/queries/traffic";
import type { PerformanceData } from "@/lib/queries/performance";
import type { DnsData } from "@/lib/queries/dns";
import type { OriginHealthData } from "@/lib/queries/origin-health";
import type { SslData } from "@/lib/queries/ssl";
import type { BotData } from "@/lib/queries/bots";
import type { ApiShieldData } from "@/lib/queries/api-shield";
import type { DdosData } from "@/lib/queries/ddos";
import type { GatewayDnsData } from "@/lib/queries/gateway-dns";
import type { GatewayNetworkData } from "@/lib/queries/gateway-network";
import type { ShadowItData } from "@/lib/queries/shadow-it";
import type { DevicesUsersData } from "@/lib/queries/devices-users";
import type { ZtSummaryData } from "@/lib/queries/zt-summary";
import type { AccessAuditData } from "@/lib/queries/access-audit";


// =============================================================================
// Helper functions
// =============================================================================

/** Convert unix epoch seconds to ISO date string */
function epochToIso(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

/** Get top_items rows for a scope/report/category, using the latest collected_at within range */
function getTopItems(
  db: Database.Database,
  scopeId: string,
  reportType: string,
  category: string,
  fromTs?: number,
  toTs?: number,
): Array<{ name: string; value: number; value2: number | null; pct: number | null; detail: string | null }> {
  let latestRow: { ca: number | null } | undefined;

  if (fromTs && toTs) {
    latestRow = db.prepare(
      `SELECT MAX(collected_at) as ca FROM top_items WHERE scope_id = ? AND report_type = ? AND category = ? AND collected_at >= ? AND collected_at <= ?`,
    ).get(scopeId, reportType, category, fromTs, toTs) as { ca: number | null } | undefined;
  }

  if (!latestRow?.ca) {
    latestRow = db.prepare(
      `SELECT MAX(collected_at) as ca FROM top_items WHERE scope_id = ? AND report_type = ? AND category = ?`,
    ).get(scopeId, reportType, category) as { ca: number | null } | undefined;
  }

  if (!latestRow?.ca) return [];

  return db.prepare(
    `SELECT name, value, value2, value_pct as pct, detail FROM top_items WHERE scope_id = ? AND report_type = ? AND category = ? AND collected_at = ? ORDER BY value DESC`,
  ).all(scopeId, reportType, category, latestRow.ca) as Array<{
    name: string;
    value: number;
    value2: number | null;
    pct: number | null;
    detail: string | null;
  }>;
}

/** Get aggregate_stats for a scope/report, latest collected_at in range */
function getAggStats(
  db: Database.Database,
  scopeId: string,
  reportType: string,
  fromTs?: number,
  toTs?: number,
): Map<string, number> {
  let latestRow: { ca: number | null } | undefined;

  if (fromTs && toTs) {
    latestRow = db.prepare(
      `SELECT MAX(collected_at) as ca FROM aggregate_stats WHERE scope_id = ? AND report_type = ? AND collected_at >= ? AND collected_at <= ?`,
    ).get(scopeId, reportType, fromTs, toTs) as { ca: number | null } | undefined;
  }

  if (!latestRow?.ca) {
    latestRow = db.prepare(
      `SELECT MAX(collected_at) as ca FROM aggregate_stats WHERE scope_id = ? AND report_type = ?`,
    ).get(scopeId, reportType) as { ca: number | null } | undefined;
  }

  if (!latestRow?.ca) return new Map();

  const rows = db.prepare(
    `SELECT stat_key, stat_value FROM aggregate_stats WHERE scope_id = ? AND report_type = ? AND collected_at = ?`,
  ).all(scopeId, reportType, latestRow.ca) as Array<{ stat_key: string; stat_value: number }>;

  return new Map(rows.map((r) => [r.stat_key, r.stat_value]));
}

/** Get recommendations for a scope/report */
function getRecommendations(
  db: Database.Database,
  scopeId: string,
  reportType: string,
  fromTs?: number,
  toTs?: number,
): Array<{ severity: string; title: string; description: string }> {
  let latestRow: { ca: number | null } | undefined;

  if (fromTs && toTs) {
    latestRow = db.prepare(
      `SELECT MAX(collected_at) as ca FROM recommendations WHERE scope_id = ? AND report_type = ? AND collected_at >= ? AND collected_at <= ?`,
    ).get(scopeId, reportType, fromTs, toTs) as { ca: number | null } | undefined;
  }

  if (!latestRow?.ca) {
    latestRow = db.prepare(
      `SELECT MAX(collected_at) as ca FROM recommendations WHERE scope_id = ? AND report_type = ?`,
    ).get(scopeId, reportType) as { ca: number | null } | undefined;
  }

  if (!latestRow?.ca) return [];

  return db.prepare(
    `SELECT severity, title, description FROM recommendations WHERE scope_id = ? AND report_type = ? AND collected_at = ?`,
  ).all(scopeId, reportType, latestRow.ca) as Array<{ severity: string; title: string; description: string }>;
}

/** Get latest collected_at for a snapshot table within the given range, falling back to most recent overall */
function getLatestCollectedAt(
  db: Database.Database,
  table: string,
  scopeColumn: string,
  scopeId: string,
  fromTs?: number,
  toTs?: number,
): number | null {
  let row: { ca: number | null } | undefined;

  if (fromTs && toTs) {
    row = db.prepare(
      `SELECT MAX(collected_at) as ca FROM ${table} WHERE ${scopeColumn} = ? AND collected_at >= ? AND collected_at <= ?`,
    ).get(scopeId, fromTs, toTs) as { ca: number | null } | undefined;
  }

  if (!row?.ca) {
    row = db.prepare(
      `SELECT MAX(collected_at) as ca FROM ${table} WHERE ${scopeColumn} = ?`,
    ).get(scopeId) as { ca: number | null } | undefined;
  }

  return row?.ca ?? null;
}

/** Get latest collected_at for protocol_distribution */
function getLatestProtocolAt(
  db: Database.Database,
  scopeId: string,
  reportType: string,
  category: string,
  fromTs?: number,
  toTs?: number,
): number | null {
  let row: { ca: number | null } | undefined;

  if (fromTs && toTs) {
    row = db.prepare(
      `SELECT MAX(collected_at) as ca FROM protocol_distribution WHERE scope_id = ? AND report_type = ? AND category = ? AND collected_at >= ? AND collected_at <= ?`,
    ).get(scopeId, reportType, category, fromTs, toTs) as { ca: number | null } | undefined;
  }

  if (!row?.ca) {
    row = db.prepare(
      `SELECT MAX(collected_at) as ca FROM protocol_distribution WHERE scope_id = ? AND report_type = ? AND category = ?`,
    ).get(scopeId, reportType, category) as { ca: number | null } | undefined;
  }

  return row?.ca ?? null;
}

/** Get protocol_distribution rows for a scope/report/category, latest in range */
function getProtocolDistribution(
  db: Database.Database,
  scopeId: string,
  reportType: string,
  category: string,
  fromTs?: number,
  toTs?: number,
): Array<{ name: string; requests: number }> {
  const ca = getLatestProtocolAt(db, scopeId, reportType, category, fromTs, toTs);
  if (!ca) return [];

  return db.prepare(
    `SELECT name, requests FROM protocol_distribution WHERE scope_id = ? AND report_type = ? AND category = ? AND collected_at = ? ORDER BY requests DESC`,
  ).all(scopeId, reportType, category, ca) as Array<{ name: string; requests: number }>;
}


// =============================================================================
// 1. Executive
// =============================================================================

function readExecutiveData(
  db: Database.Database,
  scopeId: string,
  fromTs: number,
  toTs: number,
): ExecutiveData | null {
  const stats = getAggStats(db, scopeId, "executive", fromTs, toTs);
  if (stats.size === 0) return null;

  // Derive accurate totals from time series when available
  const tsSums = db.prepare(
    `SELECT COALESCE(SUM(requests),0) as reqs, COALESCE(SUM(bandwidth),0) as bw, COALESCE(SUM(cached_requests),0) as cached FROM http_requests_ts WHERE zone_id = ? AND ts >= ? AND ts < ?`,
  ).get(scopeId, fromTs, toTs) as { reqs: number; bw: number; cached: number };

  const statusCodes = getTopItems(db, scopeId, "executive", "status_codes", fromTs, toTs);
  const topCountries = getTopItems(db, scopeId, "executive", "top_countries", fromTs, toTs);
  const recs = getRecommendations(db, scopeId, "executive", fromTs, toTs);

  const totalRequests = tsSums.reqs || (stats.get("total_requests") ?? 0);
  const totalBandwidth = tsSums.bw || (stats.get("total_bandwidth") ?? 0);
  const cachedRequests = tsSums.reqs > 0 ? tsSums.cached : (stats.get("cached_requests") ?? 0);
  const cacheHitRatio = totalRequests > 0 ? cachedRequests / totalRequests : 0;

  return {
    traffic: {
      totalRequests,
      totalBandwidth,
      cachedRequests,
      cacheHitRatio,
    },
    security: {
      totalThreatsBlocked: stats.get("total_threats_blocked") ?? 0,
      ddosMitigated: stats.get("ddos_mitigated") ?? 0,
      topThreatVectors: [],
    },
    performance: {
      ttfb: {
        avg: stats.get("ttfb_avg") ?? 0,
        p50: stats.get("ttfb_p50") ?? 0,
        p95: stats.get("ttfb_p95") ?? 0,
        p99: stats.get("ttfb_p99") ?? 0,
      },
      originResponseTime: {
        avg: stats.get("origin_avg") ?? 0,
        p50: stats.get("origin_p50") ?? 0,
        p95: stats.get("origin_p95") ?? 0,
        p99: stats.get("origin_p99") ?? 0,
      },
    },
    recommendations: recs.map((r) => ({
      severity: r.severity as "info" | "warning" | "critical",
      title: r.title,
      description: r.description,
    })),
    statusCodeBreakdown: statusCodes.map((r) => ({ name: r.name, value: r.value })),
    topCountries: topCountries.map((r) => ({ name: r.name, value: r.value })),
    summary: "",
  };
}


// =============================================================================
// 2. Security
// =============================================================================

function readSecurityData(
  db: Database.Database,
  scopeId: string,
  fromTs: number,
  toTs: number,
): SecurityEmailData | null {
  const stats = getAggStats(db, scopeId, "security", fromTs, toTs);
  if (stats.size === 0) return null;

  const sourceBreakdown = getTopItems(db, scopeId, "security", "source_breakdown", fromTs, toTs);
  const topBlockRules = getTopItems(db, scopeId, "security", "top_block_rules", fromTs, toTs);
  const topAttackingIPs = getTopItems(db, scopeId, "security", "top_attacking_ips", fromTs, toTs);
  const topAttackingCountries = getTopItems(db, scopeId, "security", "top_attacking_countries", fromTs, toTs);

  return {
    totalThreatsBlocked: stats.get("total_threats_blocked") ?? 0,
    challengeSolveRate: stats.get("challenge_solve_rate") ?? 0,
    topSources: sourceBreakdown.map((r) => ({ name: r.name, value: r.value })),
    topBlockRules: topBlockRules.map((r) => ({ name: r.name, count: r.value })),
    topAttackingIPs: topAttackingIPs.map((r) => ({ ip: r.name, count: r.value })),
    topAttackingCountries: topAttackingCountries.map((r) => ({ country: r.name, count: r.value })),
  };
}


// =============================================================================
// 3. Traffic
// =============================================================================

function readTrafficData(
  db: Database.Database,
  scopeId: string,
  fromTs: number,
  toTs: number,
): TrafficData | null {
  const tsRows = db.prepare(
    `SELECT ts, requests, bandwidth, cached_requests, cached_bandwidth, status_4xx, status_5xx FROM http_requests_ts WHERE zone_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`,
  ).all(scopeId, fromTs, toTs) as Array<{
    ts: number;
    requests: number;
    bandwidth: number;
    cached_requests: number;
    cached_bandwidth: number;
    status_4xx: number;
    status_5xx: number;
  }>;

  if (tsRows.length === 0) {
    // No time series – check if any aggregate stats exist as fallback indicator
    const stats = getAggStats(db, scopeId, "traffic", fromTs, toTs);
    if (stats.size === 0) return null;
  }

  const stats = getAggStats(db, scopeId, "traffic", fromTs, toTs);

  const timeSeries = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    requests: r.requests,
    bandwidth: r.bandwidth,
    cachedRequests: r.cached_requests,
  }));

  const errorTrend = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    "4xx": r.status_4xx,
    "5xx": r.status_5xx,
  }));

  const bandwidthByCache = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    cached: r.cached_bandwidth,
    uncached: r.bandwidth - r.cached_bandwidth,
  }));

  const statusCodes = getTopItems(db, scopeId, "traffic", "status_codes", fromTs, toTs);
  const topPaths = getTopItems(db, scopeId, "traffic", "top_paths", fromTs, toTs);
  const topCountries = getTopItems(db, scopeId, "traffic", "top_countries", fromTs, toTs);
  const contentTypes = getTopItems(db, scopeId, "traffic", "content_types", fromTs, toTs);

  // Derive totals from time series when available (agg stats only cover the last collection run)
  const tsTotalRequests = timeSeries.reduce((s, r) => s + r.requests, 0);
  const tsTotalBandwidth = timeSeries.reduce((s, r) => s + r.bandwidth, 0);
  const tsCachedRequests = timeSeries.reduce((s, r) => s + r.cachedRequests, 0);
  const totalRequests = tsTotalRequests || (stats.get("total_requests") ?? 0);
  const totalBandwidth = tsTotalBandwidth || (stats.get("total_bandwidth") ?? 0);

  // Derive cache stats from ts when we have actual data points
  const cacheHit = tsTotalRequests > 0 ? tsCachedRequests : (stats.get("cache_hit") ?? 0);
  const cacheMiss = tsTotalRequests > 0 ? tsTotalRequests - tsCachedRequests : (stats.get("cache_miss") ?? 0);
  const cacheTotal = tsTotalRequests > 0 ? tsTotalRequests : (stats.get("cache_total") ?? 0);
  const cacheRatio = cacheTotal > 0 ? cacheHit / cacheTotal : 0;

  return {
    timeSeries,
    statusCodes: statusCodes.map((r) => ({ name: r.name, value: r.value })),
    topPaths: topPaths.map((r) => ({ name: r.name, value: r.value })),
    topCountries: topCountries.map((r) => ({ name: r.name, value: r.value })),
    cache: {
      hit: cacheHit,
      miss: cacheMiss,
      total: cacheTotal,
      ratio: cacheRatio,
    },
    totalRequests,
    totalBandwidth,
    contentTypes: contentTypes.map((r) => ({ name: r.name, value: r.value })),
    errorTrend,
    bandwidthByCache,
  };
}


// =============================================================================
// 4. Performance
// =============================================================================

function readPerformanceData(
  db: Database.Database,
  scopeId: string,
  fromTs: number,
  toTs: number,
): PerformanceData | null {
  const tsRows = db.prepare(
    `SELECT ts, avg_ttfb_ms, avg_origin_time_ms, requests FROM http_requests_ts WHERE zone_id = ? AND ts >= ? AND ts < ? AND avg_ttfb_ms IS NOT NULL ORDER BY ts ASC`,
  ).all(scopeId, fromTs, toTs) as Array<{
    ts: number;
    avg_ttfb_ms: number;
    avg_origin_time_ms: number | null;
    requests: number;
  }>;

  const stats = getAggStats(db, scopeId, "performance", fromTs, toTs);

  if (tsRows.length === 0 && stats.size === 0) return null;

  const timeSeries = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    avgTtfb: r.avg_ttfb_ms,
    avgOriginTime: r.avg_origin_time_ms ?? 0,
    requests: r.requests,
  }));

  // performance_breakdown
  const perfBreakdownCa = getLatestCollectedAt(db, "performance_breakdown", "zone_id", scopeId, fromTs, toTs);
  let contentTypePerf: PerformanceData["contentTypePerf"] = [];
  let countryPerf: PerformanceData["countryPerf"] = [];
  let coloPerf: PerformanceData["coloPerf"] = [];

  if (perfBreakdownCa) {
    const contentTypeRows = db.prepare(
      `SELECT name, requests, avg_ttfb_ms, avg_origin_time_ms, avg_response_bytes FROM performance_breakdown WHERE zone_id = ? AND collected_at = ? AND dimension = 'content_type'`,
    ).all(scopeId, perfBreakdownCa) as Array<{
      name: string;
      requests: number;
      avg_ttfb_ms: number | null;
      avg_origin_time_ms: number | null;
      avg_response_bytes: number | null;
    }>;

    contentTypePerf = contentTypeRows.map((r) => ({
      contentType: r.name,
      requests: r.requests,
      avgTtfb: r.avg_ttfb_ms ?? 0,
      avgOriginTime: r.avg_origin_time_ms ?? 0,
      avgResponseBytes: r.avg_response_bytes ?? 0,
    }));

    const countryRows = db.prepare(
      `SELECT name, requests, avg_ttfb_ms, avg_origin_time_ms FROM performance_breakdown WHERE zone_id = ? AND collected_at = ? AND dimension = 'country'`,
    ).all(scopeId, perfBreakdownCa) as Array<{
      name: string;
      requests: number;
      avg_ttfb_ms: number | null;
      avg_origin_time_ms: number | null;
    }>;

    countryPerf = countryRows.map((r) => ({
      country: r.name,
      requests: r.requests,
      avgTtfb: r.avg_ttfb_ms ?? 0,
      avgOriginTime: r.avg_origin_time_ms ?? 0,
    }));

    const coloRows = db.prepare(
      `SELECT name, city, country, requests, avg_ttfb_ms FROM performance_breakdown WHERE zone_id = ? AND collected_at = ? AND dimension = 'colo'`,
    ).all(scopeId, perfBreakdownCa) as Array<{
      name: string;
      city: string | null;
      country: string | null;
      requests: number;
      avg_ttfb_ms: number | null;
    }>;

    coloPerf = coloRows.map((r) => ({
      colo: r.name,
      city: r.city ?? "",
      country: r.country ?? "",
      requests: r.requests,
      avgTtfb: r.avg_ttfb_ms ?? 0,
    }));
  }

  const protocolRows = getProtocolDistribution(db, scopeId, "performance", "http_protocol", fromTs, toTs);
  const protocolDistribution = protocolRows.map((r) => ({
    protocol: r.name,
    requests: r.requests,
  }));

  return {
    timeSeries,
    contentTypePerf,
    countryPerf,
    protocolDistribution,
    coloPerf,
    stats: {
      totalRequests: stats.get("total_requests") ?? 0,
      avgTtfb: stats.get("avg_ttfb") ?? 0,
      p95Ttfb: stats.get("p95_ttfb") ?? 0,
      avgOriginTime: stats.get("avg_origin_time") ?? 0,
      p95OriginTime: stats.get("p95_origin_time") ?? 0,
      totalBytes: stats.get("total_bytes") ?? 0,
    },
  };
}


// =============================================================================
// 5. DNS
// =============================================================================

function readDnsData(
  db: Database.Database,
  scopeId: string,
  fromTs: number,
  toTs: number,
): DnsData | null {
  const tsRows = db.prepare(
    `SELECT ts, query_type, count FROM dns_queries_ts WHERE zone_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`,
  ).all(scopeId, fromTs, toTs) as Array<{ ts: number; query_type: string; count: number }>;

  const stats = getAggStats(db, scopeId, "dns", fromTs, toTs);

  const recordsCa = getLatestCollectedAt(db, "dns_records", "zone_id", scopeId, fromTs, toTs);

  if (tsRows.length === 0 && stats.size === 0 && !recordsCa) return null;

  // Build time series pivot: group by ts, pivot query_type → columns
  const tsMap = new Map<number, Record<string, number>>();
  const queryTypeSet = new Set<string>();

  for (const row of tsRows) {
    if (!tsMap.has(row.ts)) tsMap.set(row.ts, {});
    const pt = tsMap.get(row.ts)!;
    pt[row.query_type] = (pt[row.query_type] || 0) + row.count;
    queryTypeSet.add(row.query_type);
  }

  const queryVolumeByType = Array.from(tsMap.entries())
    .map(([ts, counts]) => ({ date: epochToIso(ts), ...counts }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const queryTypes = Array.from(queryTypeSet).sort();

  // DNS records
  let dnsRecords: DnsData["dnsRecords"] = [];
  if (recordsCa) {
    const rows = db.prepare(
      `SELECT record_id, name, type, content, ttl, proxied, query_count, has_nxdomain, status, days_since_modified FROM dns_records WHERE zone_id = ? AND collected_at = ?`,
    ).all(scopeId, recordsCa) as Array<{
      record_id: string;
      name: string;
      type: string;
      content: string | null;
      ttl: number | null;
      proxied: number | null;
      query_count: number;
      has_nxdomain: number;
      status: string | null;
      days_since_modified: number | null;
    }>;

    dnsRecords = rows.map((r) => ({
      id: r.record_id,
      name: r.name,
      type: r.type,
      content: r.content ?? "",
      ttl: r.ttl ?? 0,
      proxied: !!r.proxied,
      queryCount: r.query_count,
      hasNxdomain: !!r.has_nxdomain,
      status: (r.status ?? "unqueried") as "active" | "unqueried" | "error",
      daysSinceModified: r.days_since_modified,
    }));
  }

  const responseCodeBreakdown = getTopItems(db, scopeId, "dns", "response_codes", fromTs, toTs);
  const topQueriedRaw = getTopItems(db, scopeId, "dns", "top_queried_records", fromTs, toTs);
  const nxdomainRaw = getTopItems(db, scopeId, "dns", "nxdomain_hotspots", fromTs, toTs);

  const topQueriedRecords = topQueriedRaw.map((r) => ({ name: r.name, count: r.value }));
  const nxdomainHotspots = nxdomainRaw.map((r) => ({ name: r.name, count: r.value }));

  // Derive stale records
  const staleRecords = buildStaleRecordSummary(dnsRecords);

  return {
    queryVolumeByType,
    queryTypes,
    responseCodeBreakdown: responseCodeBreakdown.map((r) => ({ name: r.name, value: r.value })),
    dnsRecords,
    topQueriedRecords,
    nxdomainHotspots,
    totalQueries: stats.get("total_queries") ?? 0,
    latency: {
      avg: stats.get("latency_avg") ?? 0,
      p50: stats.get("latency_p50") ?? 0,
      p90: stats.get("latency_p90") ?? 0,
      p99: stats.get("latency_p99") ?? 0,
    },
    staleRecords,
  };
}

function buildStaleRecordSummary(records: DnsData["dnsRecords"]): DnsData["staleRecords"] {
  const stale = records.filter((r) => r.status === "unqueried" || r.status === "error");

  const byType = new Map<string, number>();
  for (const r of stale) {
    byType.set(r.type, (byType.get(r.type) || 0) + 1);
  }
  const byTypeArr = Array.from(byType.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  const oldestUnqueried = stale
    .filter((r) => r.status === "unqueried" && r.daysSinceModified !== null)
    .sort((a, b) => (b.daysSinceModified || 0) - (a.daysSinceModified || 0))
    .slice(0, 10)
    .map((r) => ({
      name: r.name,
      type: r.type,
      daysSinceModified: r.daysSinceModified || 0,
    }));

  return { totalStale: stale.length, byType: byTypeArr, oldestUnqueried };
}


// =============================================================================
// 6. Origin Health
// =============================================================================

function readOriginHealthData(
  db: Database.Database,
  scopeId: string,
  fromTs: number,
  toTs: number,
): OriginHealthData | null {
  const tsRows = db.prepare(
    `SELECT ts, requests, avg_response_time_ms, error_rate FROM origin_health_ts WHERE zone_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`,
  ).all(scopeId, fromTs, toTs) as Array<{
    ts: number;
    requests: number;
    avg_response_time_ms: number | null;
    error_rate: number | null;
  }>;

  const stats = getAggStats(db, scopeId, "origin-health", fromTs, toTs);

  if (tsRows.length === 0 && stats.size === 0) return null;

  const timeSeries = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    avgResponseTime: r.avg_response_time_ms ?? 0,
    requests: r.requests,
    errorRate: r.error_rate ?? 0,
  }));

  // origin_status_breakdown
  const statusCa = getLatestCollectedAt(db, "origin_status_breakdown", "zone_id", scopeId, fromTs, toTs);
  let statusBreakdown: OriginHealthData["statusBreakdown"] = [];
  if (statusCa) {
    const rows = db.prepare(
      `SELECT status_code, status_group, requests, avg_response_time_ms FROM origin_status_breakdown WHERE zone_id = ? AND collected_at = ?`,
    ).all(scopeId, statusCa) as Array<{
      status_code: number;
      status_group: string;
      requests: number;
      avg_response_time_ms: number | null;
    }>;

    statusBreakdown = rows.map((r) => ({
      status: r.status_code,
      statusGroup: r.status_group,
      requests: r.requests,
      avgResponseTime: r.avg_response_time_ms ?? 0,
    }));
  }

  // health_checks
  const healthChecksCa = getLatestCollectedAt(db, "health_checks", "zone_id", scopeId, fromTs, toTs);
  let healthChecks: OriginHealthData["healthChecks"] = [];
  if (healthChecksCa) {
    const rows = db.prepare(
      `SELECT name, status, address, type, interval_sec FROM health_checks WHERE zone_id = ? AND collected_at = ?`,
    ).all(scopeId, healthChecksCa) as Array<{
      name: string;
      status: string;
      address: string | null;
      type: string | null;
      interval_sec: number | null;
    }>;

    healthChecks = rows.map((r) => ({
      name: r.name,
      status: r.status,
      address: r.address ?? "",
      type: r.type ?? "HTTPS",
      interval: r.interval_sec ?? 60,
    }));
  }

  // health_events
  const healthEventsCa = getLatestCollectedAt(db, "health_events", "zone_id", scopeId, fromTs, toTs);
  let healthEvents: OriginHealthData["healthEvents"] = [];
  if (healthEventsCa) {
    const rows = db.prepare(
      `SELECT event_time, name, status, origin_ip, response_status, rtt_ms, failure_reason, region FROM health_events WHERE zone_id = ? AND collected_at = ? ORDER BY event_time DESC`,
    ).all(scopeId, healthEventsCa) as Array<{
      event_time: number;
      name: string;
      status: string;
      origin_ip: string | null;
      response_status: number | null;
      rtt_ms: number | null;
      failure_reason: string | null;
      region: string | null;
    }>;

    healthEvents = rows.map((r) => ({
      datetime: epochToIso(r.event_time),
      name: r.name,
      status: r.status,
      originIp: r.origin_ip ?? "",
      responseStatus: r.response_status ?? 0,
      rttMs: r.rtt_ms ?? 0,
      failureReason: r.failure_reason ?? "",
      region: r.region ?? "",
    }));
  }

  return {
    statusBreakdown,
    timeSeries,
    healthChecks,
    healthEvents,
    hasHealthChecks: healthChecks.length > 0,
    stats: {
      totalRequests: stats.get("total_requests") ?? 0,
      avgResponseTime: stats.get("avg_response_time") ?? 0,
      p95ResponseTime: stats.get("p95_response_time") ?? 0,
      errorRate5xx: stats.get("error_rate_5xx") ?? 0,
      originStatuses: stats.get("origin_statuses") ?? 0,
    },
  };
}


// =============================================================================
// 7. SSL
// =============================================================================

function readSslData(
  db: Database.Database,
  scopeId: string,
  fromTs: number,
  toTs: number,
): SslData | null {
  const tlsVersions = getProtocolDistribution(db, scopeId, "ssl", "tls_version", fromTs, toTs);
  const httpProtocols = getProtocolDistribution(db, scopeId, "ssl", "http_protocol", fromTs, toTs);
  const matrixRows = getProtocolDistribution(db, scopeId, "ssl", "tls_http_matrix", fromTs, toTs);

  const stats = getAggStats(db, scopeId, "ssl", fromTs, toTs);

  const certsCa = getLatestCollectedAt(db, "ssl_certificates", "zone_id", scopeId, fromTs, toTs);
  const settingsCa = getLatestCollectedAt(db, "ssl_settings", "zone_id", scopeId, fromTs, toTs);

  if (
    tlsVersions.length === 0 &&
    httpProtocols.length === 0 &&
    stats.size === 0 &&
    !certsCa &&
    !settingsCa
  ) {
    return null;
  }

  const protocolMatrix = matrixRows.map((r) => {
    const parts = r.name.split("+");
    return {
      tlsVersion: parts[0] || r.name,
      httpProtocol: parts[1] || "",
      requests: r.requests,
    };
  });

  // Certificates
  let certificates: SslData["certificates"] = [];
  if (certsCa) {
    const rows = db.prepare(
      `SELECT cert_id, type, hosts, status, authority, validity_days, expires_on, signature_algorithms FROM ssl_certificates WHERE zone_id = ? AND collected_at = ?`,
    ).all(scopeId, certsCa) as Array<{
      cert_id: string;
      type: string;
      hosts: string;
      status: string;
      authority: string | null;
      validity_days: number | null;
      expires_on: string | null;
      signature_algorithms: string | null;
    }>;

    certificates = rows.map((r) => {
      let hosts: string[] = [];
      let signatureAlgorithms: string[] = [];
      try { hosts = JSON.parse(r.hosts); } catch { hosts = [r.hosts]; }
      try { signatureAlgorithms = JSON.parse(r.signature_algorithms ?? "[]"); } catch { signatureAlgorithms = []; }

      return {
        id: r.cert_id,
        type: r.type,
        hosts,
        status: r.status,
        authority: r.authority ?? "unknown",
        validityDays: r.validity_days ?? 0,
        expiresOn: r.expires_on ?? null,
        signatureAlgorithms,
      };
    });
  }

  // SSL settings
  const defaultSettings: SslData["settings"] = {
    mode: "unknown",
    minTlsVersion: "unknown",
    tls13: "off",
    alwaysUseHttps: false,
    autoHttpsRewrites: false,
    opportunisticEncryption: false,
    zeroRtt: false,
    http2: false,
    http3: false,
  };
  let settings: SslData["settings"] = defaultSettings;

  if (settingsCa) {
    const row = db.prepare(
      `SELECT mode, min_tls_version, tls13_enabled, always_use_https, auto_https_rewrites, opportunistic_encryption, zero_rtt, http2_enabled, http3_enabled FROM ssl_settings WHERE zone_id = ? AND collected_at = ? LIMIT 1`,
    ).get(scopeId, settingsCa) as {
      mode: string | null;
      min_tls_version: string | null;
      tls13_enabled: number | null;
      always_use_https: number | null;
      auto_https_rewrites: number | null;
      opportunistic_encryption: number | null;
      zero_rtt: number | null;
      http2_enabled: number | null;
      http3_enabled: number | null;
    } | undefined;

    if (row) {
      settings = {
        mode: row.mode ?? "unknown",
        minTlsVersion: row.min_tls_version ?? "unknown",
        tls13: row.tls13_enabled ? "on" : "off",
        alwaysUseHttps: !!row.always_use_https,
        autoHttpsRewrites: !!row.auto_https_rewrites,
        opportunisticEncryption: !!row.opportunistic_encryption,
        zeroRtt: !!row.zero_rtt,
        http2: !!row.http2_enabled,
        http3: !!row.http3_enabled,
      };
    }
  }

  // Encryption time series from http_requests_ts
  const encRows = db.prepare(
    `SELECT ts, encrypted_requests, requests FROM http_requests_ts WHERE zone_id = ? AND ts >= ? AND ts < ? AND encrypted_requests IS NOT NULL ORDER BY ts ASC`,
  ).all(scopeId, fromTs, toTs) as Array<{
    ts: number;
    encrypted_requests: number;
    requests: number;
  }>;

  const encryptionTimeSeries = encRows.map((r) => ({
    date: epochToIso(r.ts),
    encryptedRequests: r.encrypted_requests,
    totalRequests: r.requests,
    encryptedRatio: r.requests > 0 ? r.encrypted_requests / r.requests : 0,
  }));

  return {
    tlsVersions: tlsVersions.map((r) => ({ version: r.name, requests: r.requests })),
    httpProtocols: httpProtocols.map((r) => ({ protocol: r.name, requests: r.requests })),
    protocolMatrix,
    certificates,
    settings,
    encryptionTimeSeries,
    stats: {
      totalRequests: stats.get("total_requests") ?? 0,
      encryptedRequests: stats.get("encrypted_requests") ?? 0,
      encryptedPercent: stats.get("encrypted_percent") ?? 0,
      tlsv13Percent: stats.get("tlsv13_percent") ?? 0,
      http3Percent: stats.get("http3_percent") ?? 0,
      certCount: stats.get("cert_count") ?? certificates.length,
    },
  };
}


// =============================================================================
// 8. Bots
// =============================================================================

function readBotData(
  db: Database.Database,
  scopeId: string,
  fromTs: number,
  toTs: number,
): BotData | null {
  // bot_score_distribution
  const botScoreCa = (() => {
    let row: { ca: number | null } | undefined;
    if (fromTs && toTs) {
      row = db.prepare(
        `SELECT MAX(collected_at) as ca FROM bot_score_distribution WHERE scope_id = ? AND collected_at >= ? AND collected_at <= ?`,
      ).get(scopeId, fromTs, toTs) as { ca: number | null } | undefined;
    }
    if (!row?.ca) {
      row = db.prepare(
        `SELECT MAX(collected_at) as ca FROM bot_score_distribution WHERE scope_id = ?`,
      ).get(scopeId) as { ca: number | null } | undefined;
    }
    return row?.ca ?? null;
  })();

  const stats = getAggStats(db, scopeId, "bots", fromTs, toTs);

  const tsRows = db.prepare(
    `SELECT ts, automated, verified_bot, unverified_bot, human, total FROM bot_traffic_ts WHERE zone_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`,
  ).all(scopeId, fromTs, toTs) as Array<{
    ts: number;
    automated: number;
    verified_bot: number;
    unverified_bot: number;
    human: number;
    total: number;
  }>;

  if (!botScoreCa && stats.size === 0 && tsRows.length === 0) return null;

  let botScoreDistribution: BotData["botScoreDistribution"] = [];
  if (botScoreCa) {
    const rows = db.prepare(
      `SELECT range_start, range_end, count FROM bot_score_distribution WHERE scope_id = ? AND collected_at = ? ORDER BY range_start ASC`,
    ).all(scopeId, botScoreCa) as Array<{ range_start: number; range_end: number; count: number }>;

    botScoreDistribution = rows.map((r) => ({
      range: `${r.range_start}-${r.range_end}`,
      count: r.count,
    }));
  }

  const botDecisions = getTopItems(db, scopeId, "bots", "bot_decisions", fromTs, toTs);
  const topBotUserAgents = getTopItems(db, scopeId, "bots", "top_bot_user_agents", fromTs, toTs);
  const botRequestsByPath = getTopItems(db, scopeId, "bots", "bot_requests_by_path", fromTs, toTs);
  const verifiedBotCategories = getTopItems(db, scopeId, "bots", "verified_bot_categories", fromTs, toTs);

  const automatedTrafficOverTime = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    automated: r.automated,
    total: r.total,
    percentage: r.total > 0 ? (r.automated / r.total) * 100 : 0,
  }));

  const botTrend = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    verified: r.verified_bot,
    unverified: r.unverified_bot,
    human: r.human,
  }));

  return {
    botScoreDistribution,
    botManagementDecisions: botDecisions.map((r) => ({ name: r.name, value: r.value })),
    automatedTrafficOverTime,
    topBotUserAgents: topBotUserAgents.map((r) => ({ userAgent: r.name, count: r.value })),
    botRequestsByPath: botRequestsByPath.map((r) => ({ path: r.name, count: r.value })),
    verifiedBotCategories: verifiedBotCategories.map((r) => ({ category: r.name, count: r.value })),
    botTrend,
    verifiedBotTotal: stats.get("verified_bot_total") ?? 0,
    unverifiedBotTotal: stats.get("unverified_bot_total") ?? 0,
  };
}


// =============================================================================
// 9. API Shield
// =============================================================================

function readApiShieldData(
  db: Database.Database,
  scopeId: string,
  fromTs: number,
  toTs: number,
): ApiShieldData | null {
  const opsCa = getLatestCollectedAt(db, "api_operations", "zone_id", scopeId, fromTs, toTs);
  const discCa = getLatestCollectedAt(db, "api_discovered_endpoints", "zone_id", scopeId, fromTs, toTs);
  const stats = getAggStats(db, scopeId, "api-shield", fromTs, toTs);

  const tsRows = db.prepare(
    `SELECT ts, authenticated, unauthenticated FROM api_session_ts WHERE zone_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`,
  ).all(scopeId, fromTs, toTs) as Array<{
    ts: number;
    authenticated: number;
    unauthenticated: number;
  }>;

  if (!opsCa && !discCa && stats.size === 0 && tsRows.length === 0) return null;

  let managedOperations: ApiShieldData["managedOperations"] = [];
  if (opsCa) {
    const rows = db.prepare(
      `SELECT operation_id, method, host, endpoint, last_updated FROM api_operations WHERE zone_id = ? AND collected_at = ?`,
    ).all(scopeId, opsCa) as Array<{
      operation_id: string;
      method: string;
      host: string | null;
      endpoint: string;
      last_updated: string | null;
    }>;

    managedOperations = rows.map((r) => ({
      operationId: r.operation_id,
      method: r.method,
      host: r.host ?? "",
      endpoint: r.endpoint,
      lastUpdated: r.last_updated ?? "",
    }));
  }

  let discoveredEndpoints: ApiShieldData["discoveredEndpoints"] = [];
  if (discCa) {
    const rows = db.prepare(
      `SELECT method, host, endpoint, state, avg_requests_per_hour FROM api_discovered_endpoints WHERE zone_id = ? AND collected_at = ?`,
    ).all(scopeId, discCa) as Array<{
      method: string;
      host: string | null;
      endpoint: string;
      state: string | null;
      avg_requests_per_hour: number | null;
    }>;

    discoveredEndpoints = rows.map((r) => ({
      method: r.method,
      host: r.host ?? "",
      endpoint: r.endpoint,
      state: r.state ?? "review",
      avgRequestsPerHour: r.avg_requests_per_hour ?? 0,
    }));
  }

  const methodDistRows = getTopItems(db, scopeId, "api-shield", "method_distribution", fromTs, toTs);
  const topEndpointRows = getTopItems(db, scopeId, "api-shield", "top_endpoint_traffic", fromTs, toTs);

  const topEndpointTraffic = topEndpointRows.map((r) => {
    // parse detail "4xx:N,5xx:N"
    let status4xx = 0;
    let status5xx = 0;
    if (r.detail) {
      const m4 = r.detail.match(/4xx:(\d+)/);
      const m5 = r.detail.match(/5xx:(\d+)/);
      if (m4) status4xx = parseInt(m4[1], 10);
      if (m5) status5xx = parseInt(m5[1], 10);
    }
    return {
      endpointId: "",
      endpointPath: r.name,
      requests: r.value,
      status2xx: r.value2 ?? 0,
      status4xx,
      status5xx,
    };
  });

  const sessionTraffic = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    authenticated: r.authenticated,
    unauthenticated: r.unauthenticated,
  }));

  return {
    managedOperations,
    discoveredEndpoints,
    methodDistribution: methodDistRows.map((r) => ({ method: r.name, count: r.value })),
    sessionTraffic,
    topEndpointTraffic,
    stats: {
      totalManaged: stats.get("total_managed") ?? managedOperations.length,
      totalDiscovered: stats.get("total_discovered") ?? discoveredEndpoints.length,
      discoveredInReview: stats.get("discovered_in_review") ?? 0,
      avgRequestsPerHour: stats.get("avg_requests_per_hour") ?? 0,
      sessionIdentifier: "",
    },
  };
}


// =============================================================================
// 10. DDoS
// =============================================================================

function readDdosData(
  db: Database.Database,
  scopeId: string,
  fromTs: number,
  toTs: number,
): DdosData | null {
  const tsRows = db.prepare(
    `SELECT ts, l7_ddos_count, rate_limit_count FROM ddos_events_ts WHERE zone_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`,
  ).all(scopeId, fromTs, toTs) as Array<{
    ts: number;
    l7_ddos_count: number;
    rate_limit_count: number;
  }>;

  const stats = getAggStats(db, scopeId, "ddos", fromTs, toTs);

  if (tsRows.length === 0 && stats.size === 0) return null;

  const ddosEventsOverTime = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    count: r.l7_ddos_count,
  }));

  const rateLimitEventsOverTime = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    count: r.rate_limit_count,
  }));

  const ddosAttackVectors = getTopItems(db, scopeId, "ddos", "ddos_attack_vectors", fromTs, toTs);
  const ddosTopPaths = getTopItems(db, scopeId, "ddos", "ddos_top_paths", fromTs, toTs);
  const rateLimitMethods = getTopItems(db, scopeId, "ddos", "rate_limit_methods", fromTs, toTs);
  const rateLimitTopPaths = getTopItems(db, scopeId, "ddos", "rate_limit_top_paths", fromTs, toTs);

  const totalDdosEvents = stats.get("total_ddos_events") ?? ddosEventsOverTime.reduce((s, r) => s + r.count, 0);
  const totalRateLimitEvents = stats.get("total_rate_limit_events") ?? rateLimitEventsOverTime.reduce((s, r) => s + r.count, 0);

  // L3/L4 attacks
  const l34Ca = getLatestCollectedAt(db, "ddos_l34_attacks", "zone_id", scopeId, fromTs, toTs);
  let l34: DdosData["l34"] = null;

  if (l34Ca) {
    const rows = db.prepare(
      `SELECT attack_type, attack_vector, ip_protocol, destination_port, mitigation_type, packets, bits, dropped_packets, dropped_bits, start_time, end_time FROM ddos_l34_attacks WHERE zone_id = ? AND collected_at = ?`,
    ).all(scopeId, l34Ca) as Array<{
      attack_type: string | null;
      attack_vector: string | null;
      ip_protocol: string | null;
      destination_port: number | null;
      mitigation_type: string | null;
      packets: number | null;
      bits: number | null;
      dropped_packets: number | null;
      dropped_bits: number | null;
      start_time: number | null;
      end_time: number | null;
    }>;

    if (rows.length > 0) {
      const attacks = rows.map((r) => ({
        attackType: r.attack_type ?? "",
        attackVector: r.attack_vector ?? "",
        ipProtocol: r.ip_protocol ?? "",
        destinationPort: r.destination_port ?? 0,
        mitigationType: r.mitigation_type ?? "",
        packets: r.packets ?? 0,
        bits: r.bits ?? 0,
        droppedPackets: r.dropped_packets ?? 0,
        droppedBits: r.dropped_bits ?? 0,
        start: r.start_time ? epochToIso(r.start_time) : "",
        end: r.end_time ? epochToIso(r.end_time) : "",
      }));

      const l34TotalAttacks = stats.get("l34_total_attacks") ?? attacks.length;
      const l34TotalPackets = stats.get("l34_total_packets_dropped") ?? attacks.reduce((s, a) => s + a.droppedPackets, 0);
      const l34TotalBits = stats.get("l34_total_bits_dropped") ?? attacks.reduce((s, a) => s + a.droppedBits, 0);

      l34 = {
        attacks,
        totalAttacks: l34TotalAttacks,
        totalPacketsDropped: l34TotalPackets,
        totalBitsDropped: l34TotalBits,
      };
    }
  }

  return {
    ddosEventsOverTime,
    ddosAttackVectors: ddosAttackVectors.map((r) => ({ method: r.name, count: r.value })),
    ddosTopPaths: ddosTopPaths.map((r) => ({ path: r.name, count: r.value })),
    totalDdosEvents,
    rateLimitEventsOverTime,
    rateLimitMethods: rateLimitMethods.map((r) => ({ method: r.name, count: r.value })),
    rateLimitTopPaths: rateLimitTopPaths.map((r) => ({ path: r.name, count: r.value })),
    totalRateLimitEvents,
    l34,
  };
}


// =============================================================================
// 11. Gateway DNS
// =============================================================================

function readGatewayDnsData(
  db: Database.Database,
  scopeId: string,
  fromTs: number,
  toTs: number,
): GatewayDnsData | null {
  const tsRows = db.prepare(
    `SELECT ts, count FROM gateway_dns_ts WHERE account_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`,
  ).all(scopeId, fromTs, toTs) as Array<{ ts: number; count: number }>;

  const policiesCa = getLatestCollectedAt(db, "gateway_policies", "account_id", scopeId, fromTs, toTs);

  const topBlockedDomains = getTopItems(db, scopeId, "gateway-dns", "top_blocked_domains", fromTs, toTs);
  const blockedCategories = getTopItems(db, scopeId, "gateway-dns", "blocked_categories", fromTs, toTs);
  const resolverDecisions = getTopItems(db, scopeId, "gateway-dns", "resolver_decisions", fromTs, toTs);
  const topBlockedLocations = getTopItems(db, scopeId, "gateway-dns", "top_blocked_locations", fromTs, toTs);
  const locationBreakdown = getTopItems(db, scopeId, "gateway-dns", "location_breakdown", fromTs, toTs);

  if (
    tsRows.length === 0 &&
    !policiesCa &&
    topBlockedDomains.length === 0 &&
    blockedCategories.length === 0 &&
    resolverDecisions.length === 0
  ) {
    return null;
  }

  const queryVolume = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    count: r.count,
  }));

  let policyBreakdown: GatewayDnsData["policyBreakdown"] = [];
  if (policiesCa) {
    const rows = db.prepare(
      `SELECT policy_name, allowed, blocked, total FROM gateway_policies WHERE account_id = ? AND collected_at = ?`,
    ).all(scopeId, policiesCa) as Array<{
      policy_name: string;
      allowed: number;
      blocked: number;
      total: number;
    }>;

    policyBreakdown = rows.map((r) => ({
      policyName: r.policy_name,
      allowed: r.allowed,
      blocked: r.blocked,
      total: r.total,
    }));
  }

  // HTTP inspection – check gateway_http_ts
  const httpTsRows = db.prepare(
    `SELECT ts, count FROM gateway_http_ts WHERE account_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`,
  ).all(scopeId, fromTs, toTs) as Array<{ ts: number; count: number }>;

  let httpInspection: GatewayDnsData["httpInspection"] = null;
  if (httpTsRows.length > 0) {
    const httpActions = getTopItems(db, scopeId, "gateway-dns", "http_actions", fromTs, toTs);
    const httpTopHosts = getTopItems(db, scopeId, "gateway-dns", "http_top_hosts", fromTs, toTs);
    const totalRequests = httpTsRows.reduce((s, r) => s + r.count, 0);

    httpInspection = {
      totalRequests,
      byAction: httpActions.map((r) => ({ action: r.name, count: r.value })),
      topHosts: httpTopHosts.map((r) => ({ host: r.name, count: r.value })),
      timeSeries: httpTsRows.map((r) => ({ date: epochToIso(r.ts), count: r.count })),
    };
  }

  return {
    queryVolume,
    topBlockedDomains: topBlockedDomains.map((r) => ({
      domain: r.name,
      category: r.detail ?? "Uncategorized",
      count: r.value,
    })),
    blockedCategories: blockedCategories.map((r) => ({ category: r.name, count: r.value })),
    resolverDecisions: resolverDecisions.map((r) => ({ decision: r.name, count: r.value })),
    topBlockedLocations: topBlockedLocations.map((r) => ({ location: r.name, count: r.value })),
    policyBreakdown,
    locationBreakdown: locationBreakdown.map((r) => ({
      location: r.name,
      total: r.value,
      blocked: r.value2 ?? 0,
    })),
    httpInspection,
  };
}


// =============================================================================
// 12. Gateway Network
// =============================================================================

function readGatewayNetworkData(
  db: Database.Database,
  scopeId: string,
  fromTs: number,
  toTs: number,
): GatewayNetworkData | null {
  const tsRows = db.prepare(
    `SELECT ts, allowed, blocked FROM gateway_network_ts WHERE account_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`,
  ).all(scopeId, fromTs, toTs) as Array<{ ts: number; allowed: number; blocked: number }>;

  const destCa = getLatestCollectedAt(db, "gateway_blocked_destinations", "account_id", scopeId, fromTs, toTs);
  const topSourceCountries = getTopItems(db, scopeId, "gateway-network", "top_source_countries", fromTs, toTs);
  const portBreakdown = getTopItems(db, scopeId, "gateway-network", "port_breakdown", fromTs, toTs);

  if (tsRows.length === 0 && !destCa && topSourceCountries.length === 0) return null;

  const sessionsOverTime = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    allowed: r.allowed,
    blocked: r.blocked,
  }));

  let blockedDestinations: GatewayNetworkData["blockedDestinations"] = [];
  if (destCa) {
    const rows = db.prepare(
      `SELECT ip, count, country, port, protocol FROM gateway_blocked_destinations WHERE account_id = ? AND collected_at = ? ORDER BY count DESC`,
    ).all(scopeId, destCa) as Array<{
      ip: string;
      count: number;
      country: string | null;
      port: number | null;
      protocol: string | null;
    }>;

    blockedDestinations = rows.map((r) => ({
      ip: r.ip,
      count: r.count,
      country: r.country ?? "",
      port: r.port,
      protocol: r.protocol ?? "unknown",
    }));
  }

  // Transport protocols from protocol_distribution
  const transportRows = getProtocolDistribution(db, scopeId, "gateway-network", "transport", fromTs, toTs);
  const transportProtocols = transportRows.map((r) => ({
    protocol: r.name,
    count: r.requests,
  }));

  // Port breakdown: parse "PORT (SERVICE)" format
  const portBreakdownMapped = portBreakdown.map((r) => {
    const match = r.name.match(/^(\d+)\s*\(([^)]+)\)$/);
    if (match) {
      return { port: parseInt(match[1], 10), service: match[2], count: r.value };
    }
    const portNum = parseInt(r.name, 10);
    return { port: isNaN(portNum) ? 0 : portNum, service: "", count: r.value };
  });

  return {
    sessionsOverTime,
    blockedDestinations,
    topSourceCountries: topSourceCountries.map((r) => ({ country: r.name, count: r.value })),
    transportProtocols,
    portBreakdown: portBreakdownMapped,
  };
}


// =============================================================================
// 13. Shadow IT
// =============================================================================

function readShadowItData(
  db: Database.Database,
  scopeId: string,
  fromTs: number,
  toTs: number,
): ShadowItData | null {
  const appsCa = getLatestCollectedAt(db, "shadow_it_apps", "account_id", scopeId, fromTs, toTs);
  const userAppsCa = getLatestCollectedAt(db, "shadow_it_user_apps", "account_id", scopeId, fromTs, toTs);

  const tsRows = db.prepare(
    `SELECT ts, app_name, count FROM shadow_it_usage_ts WHERE account_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`,
  ).all(scopeId, fromTs, toTs) as Array<{ ts: number; app_name: string; count: number }>;

  const stats = getAggStats(db, scopeId, "shadow-it", fromTs, toTs);
  const categoryBreakdown = getTopItems(db, scopeId, "shadow-it", "category_breakdown", fromTs, toTs);

  if (!appsCa && tsRows.length === 0 && categoryBreakdown.length === 0) return null;

  let discoveredApplications: ShadowItData["discoveredApplications"] = [];
  if (appsCa) {
    const rows = db.prepare(
      `SELECT app_name, raw_name, category, count FROM shadow_it_apps WHERE account_id = ? AND collected_at = ? ORDER BY count DESC`,
    ).all(scopeId, appsCa) as Array<{
      app_name: string;
      raw_name: string | null;
      category: string | null;
      count: number;
    }>;

    discoveredApplications = rows.map((r) => ({
      name: r.app_name,
      rawName: r.raw_name ?? r.app_name,
      category: r.category ?? "Uncategorized",
      count: r.count,
    }));
  }

  // Usage trends: pivot by app_name
  const tsByAppMap = new Map<number, Record<string, number>>();
  const trendAppSet = new Set<string>();

  for (const row of tsRows) {
    if (!tsByAppMap.has(row.ts)) tsByAppMap.set(row.ts, {});
    const pt = tsByAppMap.get(row.ts)!;
    pt[row.app_name] = (pt[row.app_name] || 0) + row.count;
    trendAppSet.add(row.app_name);
  }

  const usageTrends = Array.from(tsByAppMap.entries())
    .map(([ts, counts]) => ({ date: epochToIso(ts), ...counts }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const trendAppNames = Array.from(trendAppSet);

  let userAppMappings: ShadowItData["userAppMappings"] = [];
  if (userAppsCa) {
    const rows = db.prepare(
      `SELECT email, apps, total_requests FROM shadow_it_user_apps WHERE account_id = ? AND collected_at = ? ORDER BY total_requests DESC`,
    ).all(scopeId, userAppsCa) as Array<{
      email: string;
      apps: string;
      total_requests: number;
    }>;

    userAppMappings = rows.map((r) => {
      let apps: string[] = [];
      try { apps = JSON.parse(r.apps); } catch { apps = [r.apps]; }
      return {
        email: r.email,
        apps,
        totalRequests: r.total_requests,
      };
    });
  }

  const onlyBlockedLogged = !!(stats.get("only_blocked_logged"));

  return {
    discoveredApplications,
    categoryBreakdown: categoryBreakdown.map((r) => ({ category: r.name, count: r.value })),
    usageTrends,
    trendAppNames,
    onlyBlockedLogged,
    userAppMappings,
  };
}


// =============================================================================
// 14. Devices & Users
// =============================================================================

function readDevicesUsersData(
  db: Database.Database,
  scopeId: string,
  fromTs: number,
  toTs: number,
): DevicesUsersData | null {
  const devicesCa = getLatestCollectedAt(db, "zt_devices", "account_id", scopeId, fromTs, toTs);
  const usersCa = getLatestCollectedAt(db, "zt_users", "account_id", scopeId, fromTs, toTs);
  const postureCa = getLatestCollectedAt(db, "zt_posture_rules", "account_id", scopeId, fromTs, toTs);
  const stats = getAggStats(db, scopeId, "devices-users", fromTs, toTs);

  if (!devicesCa && !usersCa && stats.size === 0) return null;

  let devices: DevicesUsersData["devices"] = [];
  if (devicesCa) {
    const rows = db.prepare(
      `SELECT device_name, user_name, email, os, os_version, warp_version, last_seen, status FROM zt_devices WHERE account_id = ? AND collected_at = ?`,
    ).all(scopeId, devicesCa) as Array<{
      device_name: string;
      user_name: string | null;
      email: string | null;
      os: string | null;
      os_version: string | null;
      warp_version: string | null;
      last_seen: number | null;
      status: string | null;
    }>;

    devices = rows.map((r) => ({
      name: r.device_name,
      user: r.user_name ?? "",
      email: r.email ?? "",
      os: r.os ?? "Unknown",
      osVersion: r.os_version ?? "",
      warpVersion: r.warp_version ?? "Unknown",
      lastSeen: r.last_seen ? epochToIso(r.last_seen) : new Date(0).toISOString(),
      status: (r.status ?? "inactive") as "active" | "inactive" | "stale",
    }));
  }

  let users: DevicesUsersData["users"] = [];
  if (usersCa) {
    const rows = db.prepare(
      `SELECT name, email, access_seat, gateway_seat, device_count, last_login FROM zt_users WHERE account_id = ? AND collected_at = ?`,
    ).all(scopeId, usersCa) as Array<{
      name: string | null;
      email: string;
      access_seat: number | null;
      gateway_seat: number | null;
      device_count: number;
      last_login: number | null;
    }>;

    users = rows.map((r) => ({
      name: r.name ?? "",
      email: r.email,
      accessSeat: !!r.access_seat,
      gatewaySeat: !!r.gateway_seat,
      deviceCount: r.device_count,
      lastLogin: r.last_login ? epochToIso(r.last_login) : null,
    }));
  }

  let postureRules: DevicesUsersData["postureRules"] = [];
  if (postureCa) {
    const rows = db.prepare(
      `SELECT name, type, description, platform, input_json FROM zt_posture_rules WHERE account_id = ? AND collected_at = ?`,
    ).all(scopeId, postureCa) as Array<{
      name: string;
      type: string;
      description: string | null;
      platform: string | null;
      input_json: string | null;
    }>;

    postureRules = rows.map((r) => ({
      name: r.name,
      type: r.type,
      description: r.description ?? "",
      platform: r.platform ?? "All platforms",
      input: r.input_json ?? "",
      deviceScope: 0,
    }));
  }

  const osDistribution = getTopItems(db, scopeId, "devices-users", "os_distribution", fromTs, toTs);
  const warpVersions = getTopItems(db, scopeId, "devices-users", "warp_versions", fromTs, toTs);

  // Health metrics: keys with prefix "health_"
  const health: DevicesUsersData["health"] = [];
  for (const [key, value] of stats) {
    if (key.startsWith("health_")) {
      const label = key.replace("health_", "").replace(/_/g, " ");
      const status: "good" | "warning" | "critical" =
        value >= 70 ? "good" : value >= 40 ? "warning" : "critical";
      health.push({
        label,
        value,
        detail: "",
        status,
      });
    }
  }

  return {
    devices,
    users,
    postureRules,
    postureError: null,
    osDistribution: osDistribution.map((r) => ({ name: r.name, value: r.value })),
    warpVersionDistribution: warpVersions.map((r) => ({ name: r.name, value: r.value })),
    plan: null,
    stats: {
      totalDevices: stats.get("total_devices") ?? devices.length,
      activeDevices: stats.get("active_devices") ?? 0,
      inactiveDevices: stats.get("inactive_devices") ?? 0,
      staleDevices: stats.get("stale_devices") ?? 0,
      totalUsers: stats.get("total_users") ?? users.length,
      accessSeats: stats.get("access_seats") ?? 0,
      gatewaySeats: stats.get("gateway_seats") ?? 0,
    },
    health,
  };
}


// =============================================================================
// 15. ZT Summary
// =============================================================================

function readZtSummaryData(
  db: Database.Database,
  scopeId: string,
  fromTs: number,
  toTs: number,
): ZtSummaryData | null {
  const stats = getAggStats(db, scopeId, "zt-summary", fromTs, toTs);

  const tsRows = db.prepare(
    `SELECT ts, unique_users, logins FROM daily_active_users_ts WHERE account_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`,
  ).all(scopeId, fromTs, toTs) as Array<{ ts: number; unique_users: number; logins: number }>;

  const resolverDecisions = getTopItems(db, scopeId, "zt-summary", "resolver_decisions", fromTs, toTs);
  const blockedByPolicy = getTopItems(db, scopeId, "zt-summary", "blocked_by_policy", fromTs, toTs);
  const topBlockedCategories = getTopItems(db, scopeId, "zt-summary", "top_blocked_categories", fromTs, toTs);

  if (stats.size === 0 && tsRows.length === 0 && resolverDecisions.length === 0) return null;

  const dailyActiveUsers = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    uniqueUsers: r.unique_users,
    logins: r.logins,
  }));

  // Compliance metrics: keys with prefix "compliance_"
  const compliance: ZtSummaryData["compliance"] = [];
  for (const [key, value] of stats) {
    if (key.startsWith("compliance_")) {
      const label = key.replace("compliance_", "").replace(/_/g, " ");
      const status: "good" | "warning" | "critical" =
        value >= 70 ? "good" : value >= 40 ? "warning" : "critical";
      compliance.push({
        label,
        value,
        detail: "",
        status,
      });
    }
  }

  return {
    totalDnsQueries: stats.get("total_dns_queries") ?? 0,
    blockedDnsQueries: stats.get("blocked_dns_queries") ?? 0,
    resolverDecisions: resolverDecisions.map((r) => ({
      id: r.detail ? parseInt(r.detail, 10) : 0,
      decision: r.name,
      count: r.value,
    })),
    blockedByPolicy: blockedByPolicy.map((r) => ({ name: r.name, value: r.value })),
    topBlockedCategories: topBlockedCategories.map((r) => ({ name: r.name, value: r.value })),
    accessLogins: {
      total: stats.get("access_logins_total") ?? 0,
      successful: stats.get("access_logins_successful") ?? 0,
    },
    fleet: {
      totalDevices: stats.get("fleet_total_devices") ?? 0,
      activeDevices: stats.get("fleet_active_devices") ?? 0,
      totalUsers: stats.get("fleet_total_users") ?? 0,
      accessSeats: stats.get("fleet_access_seats") ?? 0,
      gatewaySeats: stats.get("fleet_gateway_seats") ?? 0,
      accessApps: stats.get("fleet_access_apps") ?? 0,
    },
    plan: null,
    dailyActiveUsers,
    compliance,
  };
}


// =============================================================================
// 16. Access Audit
// =============================================================================

function readAccessAuditData(
  db: Database.Database,
  scopeId: string,
  fromTs: number,
  toTs: number,
): AccessAuditData | null {
  const tsRows = db.prepare(
    `SELECT ts, successful, failed FROM access_logins_ts WHERE account_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`,
  ).all(scopeId, fromTs, toTs) as Array<{ ts: number; successful: number; failed: number }>;

  const appStatsCa = getLatestCollectedAt(db, "access_app_stats", "account_id", scopeId, fromTs, toTs);
  const stats = getAggStats(db, scopeId, "access-audit", fromTs, toTs);

  const accessByApp = getTopItems(db, scopeId, "access-audit", "access_by_application", fromTs, toTs);
  const geographicAccess = getTopItems(db, scopeId, "access-audit", "geographic_access", fromTs, toTs);
  const identityProviders = getTopItems(db, scopeId, "access-audit", "identity_providers", fromTs, toTs);
  const failedLoginDetails = getTopItems(db, scopeId, "access-audit", "failed_login_details", fromTs, toTs);
  const failedByApp = getTopItems(db, scopeId, "access-audit", "failed_by_app", fromTs, toTs);
  const failedByCountry = getTopItems(db, scopeId, "access-audit", "failed_by_country", fromTs, toTs);
  const anomaliesRaw = getRecommendations(db, scopeId, "access-audit", fromTs, toTs);

  if (tsRows.length === 0 && !appStatsCa && stats.size === 0 && accessByApp.length === 0) return null;

  const loginsOverTime = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    successful: r.successful,
    failed: r.failed,
  }));

  let appBreakdown: AccessAuditData["appBreakdown"] = [];
  if (appStatsCa) {
    const rows = db.prepare(
      `SELECT app_id, app_name, successful, failed, total, failure_rate FROM access_app_stats WHERE account_id = ? AND collected_at = ?`,
    ).all(scopeId, appStatsCa) as Array<{
      app_id: string;
      app_name: string;
      successful: number;
      failed: number;
      total: number;
      failure_rate: number | null;
    }>;

    appBreakdown = rows.map((r) => ({
      appId: r.app_id,
      appName: r.app_name || null,
      successful: r.successful,
      failed: r.failed,
      total: r.total,
      failureRate: r.failure_rate ?? 0,
    }));
  }

  // Parse failed_login_details: detail field "country:X,idp:Y"
  const parsedFailedDetails = failedLoginDetails.map((r) => {
    let country = "";
    let identityProvider = "";
    if (r.detail) {
      const countryM = r.detail.match(/country:([^,]+)/);
      const idpM = r.detail.match(/idp:([^,]+)/);
      if (countryM) country = countryM[1];
      if (idpM) identityProvider = idpM[1];
    }
    return {
      appId: "",
      appName: r.name || null,
      country,
      identityProvider,
      count: r.value,
    };
  });

  return {
    loginsOverTime,
    accessByApplication: accessByApp.map((r) => ({
      appId: r.detail ?? "",
      appName: r.name || null,
      count: r.value,
    })),
    appBreakdown,
    geographicAccess: geographicAccess.map((r) => ({ country: r.name, count: r.value })),
    identityProviders: identityProviders.map((r) => ({ provider: r.name, count: r.value })),
    failedLoginCount: stats.get("failed_login_count") ?? 0,
    failedLoginDetails: parsedFailedDetails,
    failedByApp: failedByApp.map((r) => ({
      appId: r.detail ?? "",
      appName: r.name || null,
      count: r.value,
    })),
    failedByCountry: failedByCountry.map((r) => ({ country: r.name, count: r.value })),
    anomalies: anomaliesRaw.map((r) => ({
      severity: r.severity as "critical" | "warning" | "info",
      title: r.title,
      description: r.description,
    })),
  };
}


// =============================================================================
// Dispatcher
// =============================================================================

/**
 * Dispatcher function – reads stored data for any of the 16 report types.
 * Returns null if no data is available or the DB is unavailable.
 */
export function readReportData(
  reportType: string,
  scopeId: string,
  fromTs: number,
  toTs: number,
): unknown | null {
  const db = getDb();
  if (!db) return null;

  switch (reportType) {
    case "executive":      return readExecutiveData(db, scopeId, fromTs, toTs);
    case "security":       return readSecurityData(db, scopeId, fromTs, toTs);
    case "traffic":        return readTrafficData(db, scopeId, fromTs, toTs);
    case "performance":    return readPerformanceData(db, scopeId, fromTs, toTs);
    case "dns":            return readDnsData(db, scopeId, fromTs, toTs);
    case "origin-health":  return readOriginHealthData(db, scopeId, fromTs, toTs);
    case "ssl":            return readSslData(db, scopeId, fromTs, toTs);
    case "bots":           return readBotData(db, scopeId, fromTs, toTs);
    case "api-shield":     return readApiShieldData(db, scopeId, fromTs, toTs);
    case "ddos":           return readDdosData(db, scopeId, fromTs, toTs);
    case "gateway-dns":    return readGatewayDnsData(db, scopeId, fromTs, toTs);
    case "gateway-network":return readGatewayNetworkData(db, scopeId, fromTs, toTs);
    case "shadow-it":      return readShadowItData(db, scopeId, fromTs, toTs);
    case "devices-users":  return readDevicesUsersData(db, scopeId, fromTs, toTs);
    case "zt-summary":     return readZtSummaryData(db, scopeId, fromTs, toTs);
    case "access-audit":   return readAccessAuditData(db, scopeId, fromTs, toTs);
    default:               return null;
  }
}


// =============================================================================
// Historic data status
// =============================================================================

/**
 * Returns information about what historic data is available in the store.
 */
export function getHistoricDataStatus(): {
  available: boolean;
  scopes: Array<{ id: string; name: string; type: "zone" | "account" }>;
  dateRange: { from: number; to: number } | null;
} {
  const db = getDb();
  if (!db) return { available: false, scopes: [], dateRange: null };

  const scopes = db.prepare(
    `SELECT DISTINCT scope_id, scope_name FROM collection_log WHERE status = 'success' ORDER BY scope_name`,
  ).all() as Array<{ scope_id: string; scope_name: string }>;

  if (scopes.length === 0) return { available: false, scopes: [], dateRange: null };

  const scopeItems = scopes.map((s) => {
    const hasZoneReport = db.prepare(
      `SELECT 1 FROM collection_log WHERE scope_id = ? AND report_type IN ('executive','security','traffic','performance','dns') AND status = 'success' LIMIT 1`,
    ).get(s.scope_id);
    return {
      id: s.scope_id,
      name: s.scope_name,
      type: (hasZoneReport ? "zone" : "account") as "zone" | "account",
    };
  });

  // Get overall date range from time series tables
  const ranges: number[] = [];
  for (const table of [
    "http_requests_ts",
    "gateway_dns_ts",
    "gateway_network_ts",
    "daily_active_users_ts",
    "bot_traffic_ts",
    "ddos_events_ts",
    "origin_health_ts",
    "dns_queries_ts",
    "access_logins_ts",
  ]) {
    try {
      const minMax = db.prepare(`SELECT MIN(ts) as mn, MAX(ts) as mx FROM ${table}`).get() as {
        mn: number | null;
        mx: number | null;
      } | undefined;
      if (minMax?.mn) ranges.push(minMax.mn);
      if (minMax?.mx) ranges.push(minMax.mx);
    } catch {
      /* table may not exist */
    }
  }

  const dateRange =
    ranges.length >= 2 ? { from: Math.min(...ranges), to: Math.max(...ranges) } : null;

  return { available: true, scopes: scopeItems, dateRange };
}
