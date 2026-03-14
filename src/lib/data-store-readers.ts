/**
 * Data store reader functions – Phase 3: Raw Data Lake.
 *
 * Each function derives its typed shape from raw_* tables via SQL.
 * The readReportData dispatcher interface is unchanged.
 *
 * All reader functions take (scopeId, fromTs, toTs) where fromTs/toTs
 * are unix epoch seconds and return the typed data shape or null if no
 * data is available.
 */

import { getDb } from "@/lib/db";
import type Database from "better-sqlite3";

import type { ExecutiveData } from "@/lib/queries/executive";
import type { SecurityData } from "@/lib/queries/security";
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


// =============================================================================
// 1. Executive
// =============================================================================

function readExecutiveData(
  db: Database.Database,
  scopeId: string,
  fromTs: number,
  toTs: number,
): ExecutiveData | null {
  // Traffic totals from raw_http_hourly
  const totals = db.prepare(`
    SELECT COALESCE(SUM(requests),0) as reqs, COALESCE(SUM(bytes),0) as bw,
           COALESCE(SUM(cached_requests),0) as cached,
           COALESCE(SUM(status_4xx),0) + COALESCE(SUM(status_5xx),0) as errors
    FROM raw_http_hourly WHERE zone_id = ? AND ts >= ? AND ts < ?
  `).get(scopeId, fromTs, toTs) as { reqs: number; bw: number; cached: number; errors: number };

  // Threats blocked from raw_fw_hourly
  const fwTotals = db.prepare(`
    SELECT COALESCE(SUM(blocked),0) as blocked,
           COALESCE(SUM(challenged + managed_challenged + js_challenged),0) as challenged
    FROM raw_fw_hourly WHERE zone_id = ? AND ts >= ? AND ts < ?
  `).get(scopeId, fromTs, toTs) as { blocked: number; challenged: number };

  // DDoS mitigated from raw_fw_dim
  const ddosRow = db.prepare(`
    SELECT COALESCE(SUM(events),0) as cnt FROM raw_fw_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'l7ddos'
  `).get(scopeId, fromTs, toTs) as { cnt: number };

  if (totals.reqs === 0 && fwTotals.blocked === 0 && fwTotals.challenged === 0) return null;

  const totalRequests = totals.reqs;
  const totalBandwidth = totals.bw;
  const cachedRequests = totals.cached;
  const cacheHitRatio = totalRequests > 0 ? cachedRequests / totalRequests : 0;

  // Performance – weighted average from raw_http_hourly
  const perf = db.prepare(`
    SELECT SUM(ttfb_avg * requests) / NULLIF(SUM(CASE WHEN ttfb_avg IS NOT NULL THEN requests END),0) as ttfb_avg,
           SUM(ttfb_p50 * requests) / NULLIF(SUM(CASE WHEN ttfb_p50 IS NOT NULL THEN requests END),0) as ttfb_p50,
           SUM(ttfb_p95 * requests) / NULLIF(SUM(CASE WHEN ttfb_p95 IS NOT NULL THEN requests END),0) as ttfb_p95,
           SUM(ttfb_p99 * requests) / NULLIF(SUM(CASE WHEN ttfb_p99 IS NOT NULL THEN requests END),0) as ttfb_p99,
           SUM(origin_time_avg * requests) / NULLIF(SUM(CASE WHEN origin_time_avg IS NOT NULL THEN requests END),0) as origin_avg,
           SUM(origin_time_p50 * requests) / NULLIF(SUM(CASE WHEN origin_time_p50 IS NOT NULL THEN requests END),0) as origin_p50,
           SUM(origin_time_p95 * requests) / NULLIF(SUM(CASE WHEN origin_time_p95 IS NOT NULL THEN requests END),0) as origin_p95,
           SUM(origin_time_p99 * requests) / NULLIF(SUM(CASE WHEN origin_time_p99 IS NOT NULL THEN requests END),0) as origin_p99
    FROM raw_http_hourly WHERE zone_id = ? AND ts >= ? AND ts < ?
  `).get(scopeId, fromTs, toTs) as Record<string, number | null>;

  // Status code breakdown
  const statusCodes = db.prepare(`
    SELECT key as name, SUM(requests) as value FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'status'
    GROUP BY key ORDER BY value DESC
  `).all(scopeId, fromTs, toTs) as Array<{ name: string; value: number }>;

  // Top countries
  const topCountries = db.prepare(`
    SELECT key as name, SUM(requests) as value FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'country'
    GROUP BY key ORDER BY value DESC LIMIT 10
  `).all(scopeId, fromTs, toTs) as Array<{ name: string; value: number }>;

  return {
    traffic: {
      totalRequests,
      totalBandwidth,
      cachedRequests,
      cacheHitRatio,
    },
    security: {
      totalThreatsBlocked: fwTotals.blocked + fwTotals.challenged,
      ddosMitigated: ddosRow.cnt,
      topThreatVectors: [],
    },
    performance: {
      ttfb: {
        avg: perf.ttfb_avg ?? 0,
        p50: perf.ttfb_p50 ?? 0,
        p95: perf.ttfb_p95 ?? 0,
        p99: perf.ttfb_p99 ?? 0,
      },
      originResponseTime: {
        avg: perf.origin_avg ?? 0,
        p50: perf.origin_p50 ?? 0,
        p95: perf.origin_p95 ?? 0,
        p99: perf.origin_p99 ?? 0,
      },
    },
    recommendations: [],
    statusCodeBreakdown: statusCodes,
    topCountries,
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
): SecurityData | null {
  // WAF time series from raw_fw_hourly
  const wafRows = db.prepare(`
    SELECT ts, blocked, challenged, managed_challenged, js_challenged, challenge_solved, logged
    FROM raw_fw_hourly WHERE zone_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC
  `).all(scopeId, fromTs, toTs) as Array<{
    ts: number; blocked: number; challenged: number; managed_challenged: number;
    js_challenged: number; challenge_solved: number; logged: number;
  }>;

  // Traffic time series from raw_http_hourly
  const trafficRows = db.prepare(`
    SELECT ts, requests FROM raw_http_hourly WHERE zone_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC
  `).all(scopeId, fromTs, toTs) as Array<{ ts: number; requests: number }>;

  if (wafRows.length === 0 && trafficRows.length === 0) return null;

  const wafTimeSeries = wafRows.map((r) => ({
    date: epochToIso(r.ts),
    block: r.blocked,
    challenge: r.challenged,
    managed_challenge: r.managed_challenged,
    js_challenge: r.js_challenged,
    challenge_solved: r.challenge_solved,
    log: r.logged,
  }));

  const trafficTimeSeries = trafficRows.map((r) => ({
    date: epochToIso(r.ts),
    requests: r.requests,
  }));

  // Challenge solve rates
  const totalChallenged = wafRows.reduce((s, r) => s + r.challenged + r.managed_challenged + r.js_challenged, 0);
  const totalSolved = wafRows.reduce((s, r) => s + r.challenge_solved, 0);

  // Source breakdown from raw_fw_dim
  const sourceBreakdown = db.prepare(`
    SELECT key as name, SUM(events) as value FROM raw_fw_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'source'
    GROUP BY key ORDER BY value DESC
  `).all(scopeId, fromTs, toTs) as Array<{ name: string; value: number }>;

  // Firewall rules from raw_fw_dim dim='rule'
  const ruleRows = db.prepare(`
    SELECT key as rule_id, SUM(events) as total_hits, detail
    FROM raw_fw_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'rule'
    GROUP BY key, detail ORDER BY total_hits DESC
  `).all(scopeId, fromTs, toTs) as Array<{ rule_id: string; total_hits: number; detail: string | null }>;

  const topFirewallRules: SecurityData["topFirewallRules"] = [];
  const topSkipRules: SecurityData["topSkipRules"] = [];
  const ruleEffectiveness: SecurityData["ruleEffectiveness"] = [];

  for (const r of ruleRows) {
    const parts = (r.detail ?? "").split("|");
    const action = parts[0] || "block";
    const description = parts[1] || "";
    const entry = {
      ruleId: r.rule_id,
      ruleName: description || r.rule_id,
      description,
      action,
      count: r.total_hits,
    };
    if (action === "skip" || action === "log") {
      topSkipRules.push(entry);
    } else {
      topFirewallRules.push(entry);
    }
    ruleEffectiveness.push({
      ruleId: r.rule_id,
      ruleName: description || r.rule_id,
      description,
      totalHits: r.total_hits,
      blocks: action === "block" ? r.total_hits : 0,
      challenges: action.includes("challenge") ? r.total_hits : 0,
      logs: action === "log" ? r.total_hits : 0,
      blockRate: action === "block" ? 100 : 0,
    });
  }

  // Top attacking IPs
  const topAttackingIPs = db.prepare(`
    SELECT key as ip, SUM(events) as count FROM raw_fw_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'ip'
    GROUP BY key ORDER BY count DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ ip: string; count: number }>;

  // Top attacking countries
  const topAttackingCountries = db.prepare(`
    SELECT key as country, SUM(events) as count FROM raw_fw_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'country'
    GROUP BY key ORDER BY count DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ country: string; count: number }>;

  // Top attacking ASNs
  const topAttackingASNs = db.prepare(`
    SELECT key as asn, SUM(events) as count, detail as description FROM raw_fw_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'asn'
    GROUP BY key, detail ORDER BY count DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ asn: string; count: number; description: string | null }>;

  // Attack categories (from source dim)
  const attackCategories = sourceBreakdown.map((r) => ({
    category: r.name,
    count: r.value,
    sources: [] as string[],
  }));

  // HTTP method breakdown
  const httpMethods = db.prepare(`
    SELECT key as method, SUM(events) as count FROM raw_fw_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'method'
    GROUP BY key ORDER BY count DESC
  `).all(scopeId, fromTs, toTs) as Array<{ method: string; count: number }>;

  // Bot score distribution from raw_http_dim
  const botScoreDist = db.prepare(`
    SELECT key as range, SUM(requests) as count FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'bot_score'
    GROUP BY key ORDER BY key ASC
  `).all(scopeId, fromTs, toTs) as Array<{ range: string; count: number }>;

  return {
    wafTimeSeries,
    trafficTimeSeries,
    topFirewallRules,
    topSkipRules,
    sourceBreakdown: sourceBreakdown.map((r) => ({ name: r.name, value: r.value })),
    botScoreDistribution: botScoreDist,
    challengeSolveRates: {
      challenged: totalChallenged || wafRows.reduce((s, r) => s + r.blocked, 0),
      solved: totalSolved,
      failed: totalChallenged - totalSolved,
    },
    topAttackingIPs,
    topAttackingCountries,
    topAttackingASNs: topAttackingASNs.map((r) => ({
      asn: parseInt(r.asn, 10) || 0,
      description: r.description ?? r.asn,
      count: r.count,
    })),
    attackCategories,
    httpMethodBreakdown: httpMethods,
    ruleEffectiveness,
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
  const tsRows = db.prepare(`
    SELECT ts, requests, bytes, cached_requests, cached_bytes,
           status_4xx, status_5xx
    FROM raw_http_hourly WHERE zone_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC
  `).all(scopeId, fromTs, toTs) as Array<{
    ts: number; requests: number; bytes: number;
    cached_requests: number; cached_bytes: number;
    status_4xx: number; status_5xx: number;
  }>;

  if (tsRows.length === 0) return null;

  const timeSeries = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    requests: r.requests,
    bandwidth: r.bytes,
    cachedRequests: r.cached_requests,
  }));

  const errorTrend = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    "4xx": r.status_4xx,
    "5xx": r.status_5xx,
  }));

  const bandwidthByCache = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    cached: r.cached_bytes,
    uncached: r.bytes - r.cached_bytes,
  }));

  // Status codes from raw_http_dim
  const statusCodes = db.prepare(`
    SELECT key as name, SUM(requests) as value FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'status'
    GROUP BY key ORDER BY value DESC
  `).all(scopeId, fromTs, toTs) as Array<{ name: string; value: number }>;

  // Top paths
  const topPaths = db.prepare(`
    SELECT key as name, SUM(requests) as value FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'path'
    GROUP BY key ORDER BY value DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ name: string; value: number }>;

  // Top countries
  const topCountries = db.prepare(`
    SELECT key as name, SUM(requests) as value FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'country'
    GROUP BY key ORDER BY value DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ name: string; value: number }>;

  // Content types
  const contentTypes = db.prepare(`
    SELECT key as name, SUM(requests) as value FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'content_type'
    GROUP BY key ORDER BY value DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ name: string; value: number }>;

  const totalRequests = tsRows.reduce((s, r) => s + r.requests, 0);
  const totalBandwidth = tsRows.reduce((s, r) => s + r.bytes, 0);
  const totalCached = tsRows.reduce((s, r) => s + r.cached_requests, 0);
  const cacheRatio = totalRequests > 0 ? totalCached / totalRequests : 0;

  return {
    timeSeries,
    statusCodes,
    topPaths,
    topCountries,
    cache: {
      hit: totalCached,
      miss: totalRequests - totalCached,
      total: totalRequests,
      ratio: cacheRatio,
    },
    totalRequests,
    totalBandwidth,
    contentTypes,
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
  const tsRows = db.prepare(`
    SELECT ts, requests, ttfb_avg, origin_time_avg
    FROM raw_http_hourly
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND ttfb_avg IS NOT NULL
    ORDER BY ts ASC
  `).all(scopeId, fromTs, toTs) as Array<{
    ts: number; requests: number; ttfb_avg: number; origin_time_avg: number | null;
  }>;

  if (tsRows.length === 0) return null;

  const timeSeries = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    avgTtfb: r.ttfb_avg,
    avgOriginTime: r.origin_time_avg ?? 0,
    requests: r.requests,
  }));

  // Content type performance from raw_http_dim
  const contentTypeRows = db.prepare(`
    SELECT key as content_type, SUM(requests) as requests,
           SUM(ttfb_avg * requests) / NULLIF(SUM(CASE WHEN ttfb_avg IS NOT NULL THEN requests END),0) as avg_ttfb,
           SUM(origin_avg * requests) / NULLIF(SUM(CASE WHEN origin_avg IS NOT NULL THEN requests END),0) as avg_origin,
           SUM(bytes) / NULLIF(SUM(CASE WHEN bytes > 0 THEN requests END),0) as avg_bytes
    FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'content_type'
    GROUP BY key ORDER BY requests DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{
    content_type: string; requests: number; avg_ttfb: number | null;
    avg_origin: number | null; avg_bytes: number | null;
  }>;

  const contentTypePerf = contentTypeRows.map((r) => ({
    contentType: r.content_type,
    requests: r.requests,
    avgTtfb: r.avg_ttfb ?? 0,
    avgOriginTime: r.avg_origin ?? 0,
    avgResponseBytes: r.avg_bytes ?? 0,
  }));

  // Country performance
  const countryRows = db.prepare(`
    SELECT key as country, SUM(requests) as requests,
           SUM(ttfb_avg * requests) / NULLIF(SUM(CASE WHEN ttfb_avg IS NOT NULL THEN requests END),0) as avg_ttfb,
           SUM(origin_avg * requests) / NULLIF(SUM(CASE WHEN origin_avg IS NOT NULL THEN requests END),0) as avg_origin
    FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'country'
    GROUP BY key ORDER BY requests DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{
    country: string; requests: number; avg_ttfb: number | null; avg_origin: number | null;
  }>;

  const countryPerf = countryRows.map((r) => ({
    country: r.country,
    requests: r.requests,
    avgTtfb: r.avg_ttfb ?? 0,
    avgOriginTime: r.avg_origin ?? 0,
  }));

  // Colo performance
  const coloRows = db.prepare(`
    SELECT key as colo, SUM(requests) as requests,
           SUM(ttfb_avg * requests) / NULLIF(SUM(CASE WHEN ttfb_avg IS NOT NULL THEN requests END),0) as avg_ttfb
    FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'colo'
    GROUP BY key ORDER BY requests DESC LIMIT 30
  `).all(scopeId, fromTs, toTs) as Array<{ colo: string; requests: number; avg_ttfb: number | null }>;

  const coloPerf = coloRows.map((r) => ({
    colo: r.colo,
    city: "",
    country: "",
    requests: r.requests,
    avgTtfb: r.avg_ttfb ?? 0,
  }));

  // Protocol distribution from raw_http_dim dim='http_proto'
  const protoRows = db.prepare(`
    SELECT key as protocol, SUM(requests) as requests FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'http_proto'
    GROUP BY key ORDER BY requests DESC
  `).all(scopeId, fromTs, toTs) as Array<{ protocol: string; requests: number }>;

  const protocolDistribution = protoRows.map((r) => ({
    protocol: r.protocol,
    requests: r.requests,
  }));

  // Aggregate stats
  const totalRequests = tsRows.reduce((s, r) => s + r.requests, 0);
  const totalBytes = db.prepare(`
    SELECT COALESCE(SUM(bytes),0) as b FROM raw_http_hourly WHERE zone_id = ? AND ts >= ? AND ts < ?
  `).get(scopeId, fromTs, toTs) as { b: number };

  const aggPerf = db.prepare(`
    SELECT SUM(ttfb_avg * requests) / NULLIF(SUM(CASE WHEN ttfb_avg IS NOT NULL THEN requests END),0) as avg_ttfb,
           SUM(ttfb_p95 * requests) / NULLIF(SUM(CASE WHEN ttfb_p95 IS NOT NULL THEN requests END),0) as p95_ttfb,
           SUM(origin_time_avg * requests) / NULLIF(SUM(CASE WHEN origin_time_avg IS NOT NULL THEN requests END),0) as avg_origin,
           SUM(origin_time_p95 * requests) / NULLIF(SUM(CASE WHEN origin_time_p95 IS NOT NULL THEN requests END),0) as p95_origin
    FROM raw_http_hourly WHERE zone_id = ? AND ts >= ? AND ts < ?
  `).get(scopeId, fromTs, toTs) as Record<string, number | null>;

  return {
    timeSeries,
    contentTypePerf,
    countryPerf,
    protocolDistribution,
    coloPerf,
    stats: {
      totalRequests,
      avgTtfb: aggPerf.avg_ttfb ?? 0,
      p95Ttfb: aggPerf.p95_ttfb ?? 0,
      avgOriginTime: aggPerf.avg_origin ?? 0,
      p95OriginTime: aggPerf.p95_origin ?? 0,
      totalBytes: totalBytes.b,
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
  // Query volume by type from raw_dns_dim
  const dimRows = db.prepare(`
    SELECT ts, key as query_type, SUM(queries) as count FROM raw_dns_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'query_type'
    GROUP BY ts, key ORDER BY ts ASC
  `).all(scopeId, fromTs, toTs) as Array<{ ts: number; query_type: string; count: number }>;

  const recordsCa = getLatestCollectedAt(db, "dns_records", "zone_id", scopeId, fromTs, toTs);

  // Total queries from raw_dns_hourly
  const totalRow = db.prepare(`
    SELECT COALESCE(SUM(queries),0) as total FROM raw_dns_hourly
    WHERE zone_id = ? AND ts >= ? AND ts < ?
  `).get(scopeId, fromTs, toTs) as { total: number };

  if (dimRows.length === 0 && totalRow.total === 0 && !recordsCa) return null;

  // Build time series pivot
  const tsMap = new Map<number, Record<string, number>>();
  const queryTypeSet = new Set<string>();

  for (const row of dimRows) {
    if (!tsMap.has(row.ts)) tsMap.set(row.ts, {});
    const pt = tsMap.get(row.ts)!;
    pt[row.query_type] = (pt[row.query_type] || 0) + row.count;
    queryTypeSet.add(row.query_type);
  }

  const queryVolumeByType = Array.from(tsMap.entries())
    .map(([ts, counts]) => ({ date: epochToIso(ts), ...counts }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const queryTypes = Array.from(queryTypeSet).sort();

  // Response code breakdown
  const responseCodeBreakdown = db.prepare(`
    SELECT key as name, SUM(queries) as value FROM raw_dns_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'response_code'
    GROUP BY key ORDER BY value DESC
  `).all(scopeId, fromTs, toTs) as Array<{ name: string; value: number }>;

  // Top queried records
  const topQueriedRecords = db.prepare(`
    SELECT key as name, SUM(queries) as count FROM raw_dns_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'query_name'
    GROUP BY key ORDER BY count DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ name: string; count: number }>;

  // DNS records from snapshot table
  let dnsRecords: DnsData["dnsRecords"] = [];
  if (recordsCa) {
    const rows = db.prepare(
      `SELECT record_id, name, type, content, ttl, proxied, query_count, has_nxdomain, status, days_since_modified FROM dns_records WHERE zone_id = ? AND collected_at = ?`,
    ).all(scopeId, recordsCa) as Array<{
      record_id: string; name: string; type: string; content: string | null;
      ttl: number | null; proxied: number | null; query_count: number;
      has_nxdomain: number; status: string | null; days_since_modified: number | null;
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

  // NXDOMAIN hotspots from response_code dim
  const nxdomainHotspots = db.prepare(`
    SELECT key as name, SUM(queries) as count FROM raw_dns_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'response_code' AND key = 'NXDOMAIN'
    GROUP BY key
  `).all(scopeId, fromTs, toTs) as Array<{ name: string; count: number }>;

  // Derive stale records
  const staleRecords = buildStaleRecordSummary(dnsRecords);

  return {
    queryVolumeByType,
    queryTypes,
    responseCodeBreakdown,
    dnsRecords,
    topQueriedRecords,
    nxdomainHotspots,
    totalQueries: totalRow.total,
    latency: { avg: 0, p50: 0, p90: 0, p99: 0 },
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
  // Origin response time series from raw_http_hourly
  const tsRows = db.prepare(`
    SELECT ts, requests, origin_time_avg,
           CASE WHEN requests > 0 THEN CAST(status_5xx AS REAL) / requests ELSE 0 END as error_rate
    FROM raw_http_hourly
    WHERE zone_id = ? AND ts >= ? AND ts < ?
    ORDER BY ts ASC
  `).all(scopeId, fromTs, toTs) as Array<{
    ts: number; requests: number; origin_time_avg: number | null; error_rate: number;
  }>;

  const healthChecksCa = getLatestCollectedAt(db, "health_checks", "zone_id", scopeId, fromTs, toTs);

  // Health events from raw_health_events
  const healthEventRows = db.prepare(`
    SELECT ts, name, origin_ip, status, response_status, rtt_ms, failure_reason, region
    FROM raw_health_events
    WHERE zone_id = ? AND ts >= ? AND ts < ?
    ORDER BY ts DESC LIMIT 500
  `).all(scopeId, fromTs, toTs) as Array<{
    ts: number; name: string; origin_ip: string; status: string;
    response_status: number | null; rtt_ms: number | null;
    failure_reason: string | null; region: string | null;
  }>;

  if (tsRows.length === 0 && !healthChecksCa && healthEventRows.length === 0) return null;

  const timeSeries = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    avgResponseTime: r.origin_time_avg ?? 0,
    requests: r.requests,
    errorRate: r.error_rate,
  }));

  // Origin status breakdown from raw_http_dim dim='origin_status'
  const statusRows = db.prepare(`
    SELECT key as status_code, SUM(requests) as requests,
           SUM(origin_avg * requests) / NULLIF(SUM(CASE WHEN origin_avg IS NOT NULL THEN requests END),0) as avg_origin
    FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'origin_status'
    GROUP BY key ORDER BY requests DESC
  `).all(scopeId, fromTs, toTs) as Array<{
    status_code: string; requests: number; avg_origin: number | null;
  }>;

  const statusBreakdown = statusRows.map((r) => {
    const code = parseInt(r.status_code, 10) || 0;
    const group = code < 200 ? "1xx" : code < 300 ? "2xx" : code < 400 ? "3xx" : code < 500 ? "4xx" : "5xx";
    return {
      status: code,
      statusGroup: group,
      requests: r.requests,
      avgResponseTime: r.avg_origin ?? 0,
    };
  });

  // Health checks from snapshot table
  let healthChecks: OriginHealthData["healthChecks"] = [];
  if (healthChecksCa) {
    const rows = db.prepare(
      `SELECT name, status, address, type, interval_sec FROM health_checks WHERE zone_id = ? AND collected_at = ?`,
    ).all(scopeId, healthChecksCa) as Array<{
      name: string; status: string; address: string | null; type: string | null; interval_sec: number | null;
    }>;

    healthChecks = rows.map((r) => ({
      name: r.name,
      status: r.status,
      address: r.address ?? "",
      type: r.type ?? "HTTPS",
      interval: r.interval_sec ?? 60,
    }));
  }

  // Health events from raw_health_events
  const healthEvents = healthEventRows.map((r) => ({
    datetime: epochToIso(r.ts),
    name: r.name,
    status: r.status,
    originIp: r.origin_ip ?? "",
    responseStatus: r.response_status ?? 0,
    rttMs: r.rtt_ms ?? 0,
    failureReason: r.failure_reason ?? "",
    region: r.region ?? "",
  }));

  // Aggregate stats
  const totalRequests = tsRows.reduce((s, r) => s + r.requests, 0);
  const totalStatus5xx = db.prepare(`
    SELECT COALESCE(SUM(status_5xx),0) as cnt FROM raw_http_hourly
    WHERE zone_id = ? AND ts >= ? AND ts < ?
  `).get(scopeId, fromTs, toTs) as { cnt: number };
  const avgResponseTime = tsRows.length > 0
    ? tsRows.reduce((s, r) => s + (r.origin_time_avg ?? 0) * r.requests, 0) / Math.max(totalRequests, 1)
    : 0;

  return {
    statusBreakdown,
    timeSeries,
    healthChecks,
    healthEvents,
    hasHealthChecks: healthChecks.length > 0,
    stats: {
      totalRequests,
      avgResponseTime,
      p95ResponseTime: 0,
      errorRate5xx: totalRequests > 0 ? totalStatus5xx.cnt / totalRequests : 0,
      originStatuses: statusRows.length,
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
  // TLS versions from raw_http_dim dim='ssl_proto'
  const tlsVersionRows = db.prepare(`
    SELECT key as version, SUM(requests) as requests FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'ssl_proto'
    GROUP BY key ORDER BY requests DESC
  `).all(scopeId, fromTs, toTs) as Array<{ version: string; requests: number }>;

  // HTTP protocols from raw_http_dim dim='http_proto'
  const httpProtoRows = db.prepare(`
    SELECT key as protocol, SUM(requests) as requests FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'http_proto'
    GROUP BY key ORDER BY requests DESC
  `).all(scopeId, fromTs, toTs) as Array<{ protocol: string; requests: number }>;

  const certsCa = getLatestCollectedAt(db, "ssl_certificates", "zone_id", scopeId, fromTs, toTs);
  const settingsCa = getLatestCollectedAt(db, "ssl_settings", "zone_id", scopeId, fromTs, toTs);

  // Encryption time series from raw_http_overview_hourly
  const encRows = db.prepare(`
    SELECT ts, requests, encrypted_requests FROM raw_http_overview_hourly
    WHERE zone_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC
  `).all(scopeId, fromTs, toTs) as Array<{ ts: number; requests: number; encrypted_requests: number }>;

  if (
    tlsVersionRows.length === 0 &&
    httpProtoRows.length === 0 &&
    !certsCa && !settingsCa &&
    encRows.length === 0
  ) {
    return null;
  }

  // Protocol matrix – cross product approximation (no direct matrix in raw data)
  const protocolMatrix: SslData["protocolMatrix"] = [];

  // Certificates from snapshot table
  let certificates: SslData["certificates"] = [];
  if (certsCa) {
    const rows = db.prepare(
      `SELECT cert_id, type, hosts, status, authority, validity_days, expires_on, signature_algorithms FROM ssl_certificates WHERE zone_id = ? AND collected_at = ?`,
    ).all(scopeId, certsCa) as Array<{
      cert_id: string; type: string; hosts: string; status: string;
      authority: string | null; validity_days: number | null;
      expires_on: string | null; signature_algorithms: string | null;
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

  // SSL settings from snapshot table
  const defaultSettings: SslData["settings"] = {
    mode: "unknown", minTlsVersion: "unknown", tls13: "off",
    alwaysUseHttps: false, autoHttpsRewrites: false, opportunisticEncryption: false,
    zeroRtt: false, http2: false, http3: false,
  };
  let settings: SslData["settings"] = defaultSettings;

  if (settingsCa) {
    const row = db.prepare(
      `SELECT mode, min_tls_version, tls13_enabled, always_use_https, auto_https_rewrites, opportunistic_encryption, zero_rtt, http2_enabled, http3_enabled FROM ssl_settings WHERE zone_id = ? AND collected_at = ? LIMIT 1`,
    ).get(scopeId, settingsCa) as {
      mode: string | null; min_tls_version: string | null; tls13_enabled: number | null;
      always_use_https: number | null; auto_https_rewrites: number | null;
      opportunistic_encryption: number | null; zero_rtt: number | null;
      http2_enabled: number | null; http3_enabled: number | null;
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

  const encryptionTimeSeries = encRows.map((r) => ({
    date: epochToIso(r.ts),
    encryptedRequests: r.encrypted_requests,
    totalRequests: r.requests,
    encryptedRatio: r.requests > 0 ? r.encrypted_requests / r.requests : 0,
  }));

  // Stats
  const totalRequests = tlsVersionRows.reduce((s, r) => s + r.requests, 0) ||
    encRows.reduce((s, r) => s + r.requests, 0);
  const totalEncrypted = encRows.reduce((s, r) => s + r.encrypted_requests, 0);
  const tlsv13 = tlsVersionRows.find((r) => r.version === "TLSv1.3");
  const http3 = httpProtoRows.find((r) => r.protocol === "HTTP/3");

  return {
    tlsVersions: tlsVersionRows.map((r) => ({ version: r.version, requests: r.requests })),
    httpProtocols: httpProtoRows.map((r) => ({ protocol: r.protocol, requests: r.requests })),
    protocolMatrix,
    certificates,
    settings,
    encryptionTimeSeries,
    stats: {
      totalRequests,
      encryptedRequests: totalEncrypted,
      encryptedPercent: totalRequests > 0 ? (totalEncrypted / totalRequests) * 100 : 0,
      tlsv13Percent: totalRequests > 0 && tlsv13 ? (tlsv13.requests / totalRequests) * 100 : 0,
      http3Percent: totalRequests > 0 && http3 ? (http3.requests / totalRequests) * 100 : 0,
      certCount: certificates.length,
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
  // Bot score distribution from raw_http_dim dim='bot_score'
  const botScoreRows = db.prepare(`
    SELECT key as range, SUM(requests) as count FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'bot_score'
    GROUP BY key ORDER BY key ASC
  `).all(scopeId, fromTs, toTs) as Array<{ range: string; count: number }>;

  // Bot decisions from raw_http_dim dim='bot_decision'
  const botDecisions = db.prepare(`
    SELECT key as name, SUM(requests) as value FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'bot_decision'
    GROUP BY key ORDER BY value DESC
  `).all(scopeId, fromTs, toTs) as Array<{ name: string; value: number }>;

  // Verified bot categories from raw_http_dim dim='verified_bot'
  const verifiedBotCats = db.prepare(`
    SELECT key as category, SUM(requests) as count FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'verified_bot'
    GROUP BY key ORDER BY count DESC
  `).all(scopeId, fromTs, toTs) as Array<{ category: string; count: number }>;

  if (botScoreRows.length === 0 && botDecisions.length === 0) return null;

  // Bot time series from bot_decision dim
  const botTsRows = db.prepare(`
    SELECT ts, key, SUM(requests) as requests FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'bot_decision'
    GROUP BY ts, key ORDER BY ts ASC
  `).all(scopeId, fromTs, toTs) as Array<{ ts: number; key: string; requests: number }>;

  // Build bot trend time series
  const botTsMap = new Map<number, { verified: number; unverified: number; human: number; automated: number; total: number }>();
  for (const r of botTsRows) {
    if (!botTsMap.has(r.ts)) {
      botTsMap.set(r.ts, { verified: 0, unverified: 0, human: 0, automated: 0, total: 0 });
    }
    const entry = botTsMap.get(r.ts)!;
    entry.total += r.requests;
    const key = r.key.toLowerCase();
    if (key.includes("verified") && !key.includes("not")) {
      entry.verified += r.requests;
    } else if (key.includes("not") || key.includes("unverified")) {
      entry.unverified += r.requests;
      entry.automated += r.requests;
    } else if (key.includes("human") || key.includes("likely_human")) {
      entry.human += r.requests;
    } else {
      entry.automated += r.requests;
    }
  }

  const botTrend = Array.from(botTsMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([ts, d]) => ({
      date: epochToIso(ts),
      verified: d.verified,
      unverified: d.unverified,
      human: d.human,
    }));

  const automatedTrafficOverTime = Array.from(botTsMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([ts, d]) => ({
      date: epochToIso(ts),
      automated: d.automated,
      total: d.total,
      percentage: d.total > 0 ? (d.automated / d.total) * 100 : 0,
    }));

  // Bot user agents from raw_fw_dim dim='ua'
  const topBotUserAgents = db.prepare(`
    SELECT key as userAgent, SUM(events) as count FROM raw_fw_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'ua'
    GROUP BY key ORDER BY count DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ userAgent: string; count: number }>;

  // Bot requests by path – derived from firewall paths
  const botRequestsByPath = db.prepare(`
    SELECT key as path, SUM(events) as count FROM raw_fw_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'path'
    GROUP BY key ORDER BY count DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ path: string; count: number }>;

  // Totals
  const verifiedTotal = botDecisions.filter((d) => d.name.toLowerCase().includes("verified") && !d.name.toLowerCase().includes("not")).reduce((s, d) => s + d.value, 0);
  const unverifiedTotal = botDecisions.filter((d) => d.name.toLowerCase().includes("not") || d.name.toLowerCase().includes("unverified")).reduce((s, d) => s + d.value, 0);

  return {
    botScoreDistribution: botScoreRows,
    botManagementDecisions: botDecisions,
    automatedTrafficOverTime,
    topBotUserAgents,
    botRequestsByPath,
    verifiedBotCategories: verifiedBotCats,
    botTrend,
    verifiedBotTotal: verifiedTotal,
    unverifiedBotTotal: unverifiedTotal,
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

  if (!opsCa && !discCa) return null;

  let managedOperations: ApiShieldData["managedOperations"] = [];
  if (opsCa) {
    const rows = db.prepare(
      `SELECT operation_id, method, host, endpoint, last_updated FROM api_operations WHERE zone_id = ? AND collected_at = ?`,
    ).all(scopeId, opsCa) as Array<{
      operation_id: string; method: string; host: string | null; endpoint: string; last_updated: string | null;
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
      method: string; host: string | null; endpoint: string; state: string | null; avg_requests_per_hour: number | null;
    }>;

    discoveredEndpoints = rows.map((r) => ({
      method: r.method,
      host: r.host ?? "",
      endpoint: r.endpoint,
      state: r.state ?? "review",
      avgRequestsPerHour: r.avg_requests_per_hour ?? 0,
    }));
  }

  // Method distribution from raw_http_dim
  const methodDist = db.prepare(`
    SELECT key as method, SUM(requests) as count FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'method'
    GROUP BY key ORDER BY count DESC
  `).all(scopeId, fromTs, toTs) as Array<{ method: string; count: number }>;

  // Top endpoint traffic from raw_http_dim dim='path'
  const topPaths = db.prepare(`
    SELECT key as path, SUM(requests) as requests FROM raw_http_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'path'
    GROUP BY key ORDER BY requests DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ path: string; requests: number }>;

  const topEndpointTraffic = topPaths.map((r) => ({
    endpointId: "",
    endpointPath: r.path,
    requests: r.requests,
    status2xx: 0,
    status4xx: 0,
    status5xx: 0,
  }));

  return {
    managedOperations,
    discoveredEndpoints,
    methodDistribution: methodDist,
    sessionTraffic: [],
    topEndpointTraffic,
    stats: {
      totalManaged: managedOperations.length,
      totalDiscovered: discoveredEndpoints.length,
      discoveredInReview: discoveredEndpoints.filter((e) => e.state === "review").length,
      avgRequestsPerHour: 0,
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
  // DDoS events from raw_fw_dim dim='l7ddos' – hourly aggregation
  const ddosRows = db.prepare(`
    SELECT ts, SUM(events) as count FROM raw_fw_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'l7ddos'
    GROUP BY ts ORDER BY ts ASC
  `).all(scopeId, fromTs, toTs) as Array<{ ts: number; count: number }>;

  // Rate limit events from raw_fw_dim dim='ratelimit' – hourly aggregation
  const rlRows = db.prepare(`
    SELECT ts, SUM(events) as count FROM raw_fw_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'ratelimit'
    GROUP BY ts ORDER BY ts ASC
  `).all(scopeId, fromTs, toTs) as Array<{ ts: number; count: number }>;

  // L3/L4 attacks from ddos_l34_attacks (kept snapshot table)
  const l34Ca = getLatestCollectedAt(db, "ddos_l34_attacks", "zone_id", scopeId, fromTs, toTs);

  if (ddosRows.length === 0 && rlRows.length === 0 && !l34Ca) return null;

  const ddosEventsOverTime = ddosRows.map((r) => ({ date: epochToIso(r.ts), count: r.count }));
  const rateLimitEventsOverTime = rlRows.map((r) => ({ date: epochToIso(r.ts), count: r.count }));

  // DDoS attack vectors (top paths)
  const ddosAttackVectors = db.prepare(`
    SELECT key as method, SUM(events) as count FROM raw_fw_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'l7ddos'
    GROUP BY key ORDER BY count DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ method: string; count: number }>;

  const ddosTopPaths = ddosAttackVectors.map((r) => ({ path: r.method, count: r.count }));

  // Rate limit methods/paths
  const rateLimitItems = db.prepare(`
    SELECT key, SUM(events) as count FROM raw_fw_dim
    WHERE zone_id = ? AND ts >= ? AND ts < ? AND dim = 'ratelimit'
    GROUP BY key ORDER BY count DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ key: string; count: number }>;

  const rateLimitMethods: Array<{ method: string; count: number }> = [];
  const rateLimitTopPaths: Array<{ path: string; count: number }> = [];
  for (const r of rateLimitItems) {
    const parts = r.key.split(" ", 2);
    if (parts.length >= 2) {
      rateLimitMethods.push({ method: parts[0], count: r.count });
      rateLimitTopPaths.push({ path: parts[1], count: r.count });
    } else {
      rateLimitTopPaths.push({ path: r.key, count: r.count });
    }
  }

  const totalDdosEvents = ddosRows.reduce((s, r) => s + r.count, 0);
  const totalRateLimitEvents = rlRows.reduce((s, r) => s + r.count, 0);

  // L3/L4 attacks
  let l34: DdosData["l34"] = null;
  if (l34Ca) {
    const rows = db.prepare(
      `SELECT attack_type, attack_vector, ip_protocol, destination_port, mitigation_type, packets, bits, dropped_packets, dropped_bits, start_time, end_time FROM ddos_l34_attacks WHERE zone_id = ? AND collected_at = ?`,
    ).all(scopeId, l34Ca) as Array<{
      attack_type: string | null; attack_vector: string | null; ip_protocol: string | null;
      destination_port: number | null; mitigation_type: string | null;
      packets: number | null; bits: number | null;
      dropped_packets: number | null; dropped_bits: number | null;
      start_time: number | null; end_time: number | null;
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

      l34 = {
        attacks,
        totalAttacks: attacks.length,
        totalPacketsDropped: attacks.reduce((s, a) => s + a.droppedPackets, 0),
        totalBitsDropped: attacks.reduce((s, a) => s + a.droppedBits, 0),
      };
    }
  }

  return {
    ddosEventsOverTime,
    ddosAttackVectors,
    ddosTopPaths,
    totalDdosEvents,
    rateLimitEventsOverTime,
    rateLimitMethods,
    rateLimitTopPaths,
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
  // Query volume from raw_gw_dns_hourly
  const tsRows = db.prepare(`
    SELECT ts, total as count FROM raw_gw_dns_hourly
    WHERE account_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC
  `).all(scopeId, fromTs, toTs) as Array<{ ts: number; count: number }>;

  // Top blocked domains
  const topBlockedDomains = db.prepare(`
    SELECT key as domain, SUM(queries) as count FROM raw_gw_dns_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'blocked_domain'
    GROUP BY key ORDER BY count DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ domain: string; count: number }>;

  // Blocked categories
  const blockedCategories = db.prepare(`
    SELECT key as category, SUM(queries) as count FROM raw_gw_dns_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'category'
    GROUP BY key ORDER BY count DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ category: string; count: number }>;

  // Resolver decisions
  const resolverDecisions = db.prepare(`
    SELECT key as decision, SUM(queries) as count FROM raw_gw_dns_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'decision'
    GROUP BY key ORDER BY count DESC
  `).all(scopeId, fromTs, toTs) as Array<{ decision: string; count: number }>;

  if (tsRows.length === 0 && resolverDecisions.length === 0 && topBlockedDomains.length === 0) {
    return null;
  }

  const queryVolume = tsRows.map((r) => ({ date: epochToIso(r.ts), count: r.count }));

  // Location breakdown from raw_gw_dns_dim dim='location'
  const BLOCKED_DECISIONS = new Set(["2", "3", "4", "5", "6", "7", "9", "15", "16"]);

  const locationRows = db.prepare(`
    SELECT key as location, detail as decision, SUM(queries) as count FROM raw_gw_dns_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'location'
    GROUP BY key, detail ORDER BY count DESC
  `).all(scopeId, fromTs, toTs) as Array<{ location: string; decision: string | null; count: number }>;

  // Aggregate location data
  const locationMap = new Map<string, { total: number; blocked: number }>();
  for (const r of locationRows) {
    if (!locationMap.has(r.location)) locationMap.set(r.location, { total: 0, blocked: 0 });
    const loc = locationMap.get(r.location)!;
    loc.total += r.count;
    if (r.decision && BLOCKED_DECISIONS.has(r.decision)) loc.blocked += r.count;
  }

  const locationBreakdown = Array.from(locationMap.entries())
    .map(([location, data]) => ({ location, total: data.total, blocked: data.blocked }))
    .sort((a, b) => b.total - a.total);

  const topBlockedLocations = locationBreakdown
    .filter((l) => l.blocked > 0)
    .sort((a, b) => b.blocked - a.blocked)
    .slice(0, 10)
    .map((l) => ({ location: l.location, count: l.blocked }));

  // Policy breakdown from raw_gw_dns_dim dim='policy'
  const policyRows = db.prepare(`
    SELECT key as policy_name, detail as decision, SUM(queries) as count FROM raw_gw_dns_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'policy'
    GROUP BY key, detail ORDER BY count DESC
  `).all(scopeId, fromTs, toTs) as Array<{ policy_name: string; decision: string | null; count: number }>;

  const policyMap = new Map<string, { allowed: number; blocked: number; total: number }>();
  for (const r of policyRows) {
    if (!policyMap.has(r.policy_name)) policyMap.set(r.policy_name, { allowed: 0, blocked: 0, total: 0 });
    const p = policyMap.get(r.policy_name)!;
    p.total += r.count;
    if (r.decision && BLOCKED_DECISIONS.has(r.decision)) p.blocked += r.count;
    else p.allowed += r.count;
  }

  const policyBreakdown = Array.from(policyMap.entries())
    .map(([policyName, d]) => ({ policyName, allowed: d.allowed, blocked: d.blocked, total: d.total }))
    .sort((a, b) => b.total - a.total);

  // HTTP inspection from raw_gw_http_hourly + raw_gw_http_dim
  const httpTsRows = db.prepare(`
    SELECT ts, total as count FROM raw_gw_http_hourly
    WHERE account_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC
  `).all(scopeId, fromTs, toTs) as Array<{ ts: number; count: number }>;

  let httpInspection: GatewayDnsData["httpInspection"] = null;
  if (httpTsRows.length > 0) {
    const httpActions = db.prepare(`
      SELECT key as action, SUM(requests) as count FROM raw_gw_http_dim
      WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'action'
      GROUP BY key ORDER BY count DESC
    `).all(scopeId, fromTs, toTs) as Array<{ action: string; count: number }>;

    const httpTopHosts = db.prepare(`
      SELECT key as host, SUM(requests) as count FROM raw_gw_http_dim
      WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'host'
      GROUP BY key ORDER BY count DESC LIMIT 20
    `).all(scopeId, fromTs, toTs) as Array<{ host: string; count: number }>;

    const totalRequests = httpTsRows.reduce((s, r) => s + r.count, 0);

    httpInspection = {
      totalRequests,
      byAction: httpActions,
      topHosts: httpTopHosts,
      timeSeries: httpTsRows.map((r) => ({ date: epochToIso(r.ts), count: r.count })),
    };
  }

  return {
    queryVolume,
    topBlockedDomains: topBlockedDomains.map((r) => ({
      domain: r.domain,
      category: "Uncategorized",
      count: r.count,
    })),
    blockedCategories,
    resolverDecisions,
    topBlockedLocations,
    policyBreakdown,
    locationBreakdown,
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
  // Sessions over time from raw_gw_net_hourly
  const tsRows = db.prepare(`
    SELECT ts, allowed, blocked FROM raw_gw_net_hourly
    WHERE account_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC
  `).all(scopeId, fromTs, toTs) as Array<{ ts: number; allowed: number; blocked: number }>;

  // Top source countries
  const topSourceCountries = db.prepare(`
    SELECT key as country, SUM(sessions) as count FROM raw_gw_net_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'src_country'
    GROUP BY key ORDER BY count DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ country: string; count: number }>;

  if (tsRows.length === 0 && topSourceCountries.length === 0) return null;

  const sessionsOverTime = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    allowed: r.allowed,
    blocked: r.blocked,
  }));

  // Blocked destinations from raw_gw_net_dim dim='blocked_dest'
  const destRows = db.prepare(`
    SELECT key as ip, SUM(sessions) as count, detail FROM raw_gw_net_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'blocked_dest'
    GROUP BY key, detail ORDER BY count DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ ip: string; count: number; detail: string | null }>;

  const blockedDestinations = destRows.map((r) => {
    let country = "";
    let port: number | null = null;
    let protocol = "unknown";
    if (r.detail) {
      const cm = r.detail.match(/country:([^,]+)/);
      const pm = r.detail.match(/port:(\d+)/);
      const protom = r.detail.match(/proto:(\w+)/);
      if (cm) country = cm[1];
      if (pm) port = parseInt(pm[1], 10);
      if (protom) protocol = protom[1];
    }
    return { ip: r.ip, count: r.count, country, port, protocol };
  });

  // Transport protocols
  const transportRows = db.prepare(`
    SELECT key as protocol, SUM(sessions) as count FROM raw_gw_net_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'transport'
    GROUP BY key ORDER BY count DESC
  `).all(scopeId, fromTs, toTs) as Array<{ protocol: string; count: number }>;

  // Port breakdown
  const portRows = db.prepare(`
    SELECT key, SUM(sessions) as count FROM raw_gw_net_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'port'
    GROUP BY key ORDER BY count DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ key: string; count: number }>;

  const portBreakdown = portRows.map((r) => {
    const portNum = parseInt(r.key, 10);
    return { port: isNaN(portNum) ? 0 : portNum, service: "", count: r.count };
  });

  return {
    sessionsOverTime,
    blockedDestinations,
    topSourceCountries,
    transportProtocols: transportRows,
    portBreakdown,
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
  // Shadow IT is derived from Gateway HTTP data (hosts as "applications")
  const hostRows = db.prepare(`
    SELECT key as name, SUM(requests) as count FROM raw_gw_http_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'host'
    GROUP BY key ORDER BY count DESC LIMIT 50
  `).all(scopeId, fromTs, toTs) as Array<{ name: string; count: number }>;

  if (hostRows.length === 0) return null;

  const discoveredApplications = hostRows.map((r) => ({
    name: r.name,
    rawName: r.name,
    category: "Uncategorized",
    count: r.count,
  }));

  // Usage trends – hosts over time
  const trendRows = db.prepare(`
    SELECT ts, key as app_name, SUM(requests) as count FROM raw_gw_http_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'host'
    GROUP BY ts, key ORDER BY ts ASC
  `).all(scopeId, fromTs, toTs) as Array<{ ts: number; app_name: string; count: number }>;

  const tsByAppMap = new Map<number, Record<string, number>>();
  const trendAppSet = new Set<string>();

  for (const row of trendRows) {
    if (!tsByAppMap.has(row.ts)) tsByAppMap.set(row.ts, {});
    const pt = tsByAppMap.get(row.ts)!;
    pt[row.app_name] = (pt[row.app_name] || 0) + row.count;
    trendAppSet.add(row.app_name);
  }

  const usageTrends = Array.from(tsByAppMap.entries())
    .map(([ts, counts]) => ({ date: epochToIso(ts), ...counts }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    discoveredApplications,
    categoryBreakdown: [],
    usageTrends,
    trendAppNames: Array.from(trendAppSet),
    onlyBlockedLogged: false,
    userAppMappings: [],
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

  if (!devicesCa && !usersCa) return null;

  let devices: DevicesUsersData["devices"] = [];
  if (devicesCa) {
    const rows = db.prepare(
      `SELECT device_name, user_name, email, os, os_version, warp_version, last_seen, status FROM zt_devices WHERE account_id = ? AND collected_at = ?`,
    ).all(scopeId, devicesCa) as Array<{
      device_name: string; user_name: string | null; email: string | null;
      os: string | null; os_version: string | null; warp_version: string | null;
      last_seen: number | null; status: string | null;
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
      name: string | null; email: string; access_seat: number | null;
      gateway_seat: number | null; device_count: number; last_login: number | null;
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
      name: string; type: string; description: string | null; platform: string | null; input_json: string | null;
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

  // OS distribution from devices
  const osMap = new Map<string, number>();
  const warpMap = new Map<string, number>();
  let activeCount = 0;
  let inactiveCount = 0;
  let staleCount = 0;
  for (const d of devices) {
    osMap.set(d.os, (osMap.get(d.os) || 0) + 1);
    warpMap.set(d.warpVersion, (warpMap.get(d.warpVersion) || 0) + 1);
    if (d.status === "active") activeCount++;
    else if (d.status === "stale") staleCount++;
    else inactiveCount++;
  }

  const osDistribution = Array.from(osMap.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
  const warpVersionDistribution = Array.from(warpMap.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  const accessSeats = users.filter((u) => u.accessSeat).length;
  const gatewaySeats = users.filter((u) => u.gatewaySeat).length;

  return {
    devices,
    users,
    postureRules,
    postureError: null,
    osDistribution,
    warpVersionDistribution,
    plan: null,
    stats: {
      totalDevices: devices.length,
      activeDevices: activeCount,
      inactiveDevices: inactiveCount,
      staleDevices: staleCount,
      totalUsers: users.length,
      accessSeats,
      gatewaySeats,
    },
    health: [],
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
  // DNS totals from raw_gw_dns_hourly
  const dnsTotals = db.prepare(`
    SELECT COALESCE(SUM(total),0) as total, COALESCE(SUM(blocked),0) as blocked
    FROM raw_gw_dns_hourly WHERE account_id = ? AND ts >= ? AND ts < ?
  `).get(scopeId, fromTs, toTs) as { total: number; blocked: number };

  // Resolver decisions
  const resolverDecisions = db.prepare(`
    SELECT key as decision, SUM(queries) as count FROM raw_gw_dns_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'decision'
    GROUP BY key ORDER BY count DESC
  `).all(scopeId, fromTs, toTs) as Array<{ decision: string; count: number }>;

  // Access logins from raw_access_daily
  const accessTotals = db.prepare(`
    SELECT COALESCE(SUM(successful),0) as successful, COALESCE(SUM(successful + failed),0) as total
    FROM raw_access_daily WHERE account_id = ? AND ts >= ? AND ts < ?
  `).get(scopeId, fromTs, toTs) as { successful: number; total: number };

  // Fleet from snapshots
  const devicesCa = getLatestCollectedAt(db, "zt_devices", "account_id", scopeId, fromTs, toTs);
  const usersCa = getLatestCollectedAt(db, "zt_users", "account_id", scopeId, fromTs, toTs);

  if (dnsTotals.total === 0 && resolverDecisions.length === 0 && accessTotals.total === 0 && !devicesCa) {
    return null;
  }

  // Top blocked categories
  const topBlockedCategories = db.prepare(`
    SELECT key as name, SUM(queries) as value FROM raw_gw_dns_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'category'
    GROUP BY key ORDER BY value DESC LIMIT 10
  `).all(scopeId, fromTs, toTs) as Array<{ name: string; value: number }>;

  // Blocked by policy
  const BLOCKED_DECISIONS = new Set(["2", "3", "4", "5", "6", "7", "9", "15", "16"]);
  const policyRows = db.prepare(`
    SELECT key as name, SUM(queries) as value FROM raw_gw_dns_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'policy'
    GROUP BY key ORDER BY value DESC
  `).all(scopeId, fromTs, toTs) as Array<{ name: string; value: number }>;

  // Daily active users from raw_access_dim dim='user'
  const dauRows = db.prepare(`
    SELECT ts, COUNT(DISTINCT key) as unique_users, SUM(logins) as logins
    FROM raw_access_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'user'
    GROUP BY ts ORDER BY ts ASC
  `).all(scopeId, fromTs, toTs) as Array<{ ts: number; unique_users: number; logins: number }>;

  const dailyActiveUsers = dauRows.map((r) => ({
    date: epochToIso(r.ts),
    uniqueUsers: r.unique_users,
    logins: r.logins,
  }));

  // Fleet stats from snapshots
  let fleetDevices = 0;
  let fleetActiveDevices = 0;
  let fleetUsers = 0;
  let fleetAccessSeats = 0;
  let fleetGatewaySeats = 0;

  if (devicesCa) {
    const dRow = db.prepare(
      `SELECT COUNT(*) as total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active FROM zt_devices WHERE account_id = ? AND collected_at = ?`,
    ).get(scopeId, devicesCa) as { total: number; active: number };
    fleetDevices = dRow.total;
    fleetActiveDevices = dRow.active;
  }
  if (usersCa) {
    const uRow = db.prepare(
      `SELECT COUNT(*) as total, SUM(CASE WHEN access_seat = 1 THEN 1 ELSE 0 END) as access_seats, SUM(CASE WHEN gateway_seat = 1 THEN 1 ELSE 0 END) as gateway_seats FROM zt_users WHERE account_id = ? AND collected_at = ?`,
    ).get(scopeId, usersCa) as { total: number; access_seats: number; gateway_seats: number };
    fleetUsers = uRow.total;
    fleetAccessSeats = uRow.access_seats;
    fleetGatewaySeats = uRow.gateway_seats;
  }

  // Access apps from access_app_stats
  const appsCa = getLatestCollectedAt(db, "access_app_stats", "account_id", scopeId, fromTs, toTs);
  let fleetAccessApps = 0;
  if (appsCa) {
    const aRow = db.prepare(
      `SELECT COUNT(DISTINCT app_id) as cnt FROM access_app_stats WHERE account_id = ? AND collected_at = ?`,
    ).get(scopeId, appsCa) as { cnt: number };
    fleetAccessApps = aRow.cnt;
  }

  return {
    totalDnsQueries: dnsTotals.total,
    blockedDnsQueries: dnsTotals.blocked,
    resolverDecisions: resolverDecisions.map((r) => ({
      id: parseInt(r.decision, 10) || 0,
      decision: r.decision,
      count: r.count,
    })),
    blockedByPolicy: policyRows,
    topBlockedCategories,
    accessLogins: {
      total: accessTotals.total,
      successful: accessTotals.successful,
    },
    fleet: {
      totalDevices: fleetDevices,
      activeDevices: fleetActiveDevices,
      totalUsers: fleetUsers,
      accessSeats: fleetAccessSeats,
      gatewaySeats: fleetGatewaySeats,
      accessApps: fleetAccessApps,
    },
    plan: null,
    dailyActiveUsers,
    compliance: [],
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
  // Logins over time from raw_access_daily
  const tsRows = db.prepare(`
    SELECT ts, successful, failed FROM raw_access_daily
    WHERE account_id = ? AND ts >= ? AND ts < ? ORDER BY ts ASC
  `).all(scopeId, fromTs, toTs) as Array<{ ts: number; successful: number; failed: number }>;

  const appStatsCa = getLatestCollectedAt(db, "access_app_stats", "account_id", scopeId, fromTs, toTs);

  // Access by application from raw_access_dim dim='app'
  const accessByApp = db.prepare(`
    SELECT key as app_id, SUM(logins) as count FROM raw_access_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'app'
    GROUP BY key ORDER BY count DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ app_id: string; count: number }>;

  // Geographic access
  const geographicAccess = db.prepare(`
    SELECT key as country, SUM(logins) as count FROM raw_access_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'country'
    GROUP BY key ORDER BY count DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ country: string; count: number }>;

  // Identity providers
  const identityProviders = db.prepare(`
    SELECT key as provider, SUM(logins) as count FROM raw_access_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'idp'
    GROUP BY key ORDER BY count DESC
  `).all(scopeId, fromTs, toTs) as Array<{ provider: string; count: number }>;

  if (tsRows.length === 0 && !appStatsCa && accessByApp.length === 0) return null;

  const loginsOverTime = tsRows.map((r) => ({
    date: epochToIso(r.ts),
    successful: r.successful,
    failed: r.failed,
  }));

  // App breakdown from access_app_stats
  let appBreakdown: AccessAuditData["appBreakdown"] = [];
  if (appStatsCa) {
    const rows = db.prepare(
      `SELECT app_id, app_name, successful, failed, total, failure_rate FROM access_app_stats WHERE account_id = ? AND collected_at = ?`,
    ).all(scopeId, appStatsCa) as Array<{
      app_id: string; app_name: string; successful: number; failed: number;
      total: number; failure_rate: number | null;
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

  // Failed logins from raw_access_dim dim='app' where detail='0' (isSuccessfulLogin=0)
  const failedByAppRows = db.prepare(`
    SELECT key as app_id, SUM(logins) as count FROM raw_access_dim
    WHERE account_id = ? AND ts >= ? AND ts < ? AND dim = 'app' AND detail = '0'
    GROUP BY key ORDER BY count DESC LIMIT 20
  `).all(scopeId, fromTs, toTs) as Array<{ app_id: string; count: number }>;

  const failedLoginCount = tsRows.reduce((s, r) => s + r.failed, 0);

  return {
    loginsOverTime,
    accessByApplication: accessByApp.map((r) => ({
      appId: r.app_id,
      appName: null,
      count: r.count,
    })),
    appBreakdown,
    geographicAccess,
    identityProviders,
    failedLoginCount,
    failedLoginDetails: [],
    failedByApp: failedByAppRows.map((r) => ({
      appId: r.app_id,
      appName: null,
      count: r.count,
    })),
    failedByCountry: [],
    anomalies: [],
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
  lastCollectedAt: number | null;
} {
  const db = getDb();
  if (!db) return { available: false, scopes: [], dateRange: null, lastCollectedAt: null };

  const scopes = db.prepare(
    `SELECT DISTINCT scope_id, scope_name FROM collection_log WHERE status = 'success' ORDER BY scope_name`,
  ).all() as Array<{ scope_id: string; scope_name: string }>;

  if (scopes.length === 0) return { available: false, scopes: [], dateRange: null, lastCollectedAt: null };

  const scopeItems = scopes.map((s) => {
    // Zone datasets: http, firewall, dns, health
    const hasZoneReport = db.prepare(
      `SELECT 1 FROM collection_log WHERE scope_id = ? AND report_type IN ('http','firewall','dns','health','executive','security','traffic','performance') AND status = 'success' LIMIT 1`,
    ).get(s.scope_id);
    return {
      id: s.scope_id,
      name: s.scope_name,
      type: (hasZoneReport ? "zone" : "account") as "zone" | "account",
    };
  });

  // Get overall date range from raw time series tables
  const ranges: number[] = [];
  for (const table of [
    "raw_http_hourly",
    "raw_fw_hourly",
    "raw_dns_hourly",
    "raw_health_events",
    "raw_gw_dns_hourly",
    "raw_gw_net_hourly",
    "raw_gw_http_hourly",
    "raw_access_daily",
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

  // Most recent successful collection timestamp
  let lastCollectedAt: number | null = null;
  try {
    const lastRow = db.prepare(
      "SELECT MAX(collected_at) as last_ts FROM collection_log WHERE status = 'success'",
    ).get() as { last_ts: number | null } | undefined;
    lastCollectedAt = lastRow?.last_ts ?? null;
  } catch {
    /* table may not exist */
  }

  return { available: true, scopes: scopeItems, dateRange, lastCollectedAt };
}
