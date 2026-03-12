/**
 * Normalized data store module.
 *
 * Decomposes report data objects into normalized SQLite table rows.
 * Each of the 16 report types has a dedicated store function that maps
 * the fetcher's return shape into the appropriate tables.
 *
 * Design patterns:
 *   - All functions check `getDb()` and return early if null (graceful degradation)
 *   - Time series tables use INSERT OR REPLACE (dedup via PRIMARY KEY)
 *   - Snapshot tables use plain INSERT (each collection creates new rows)
 *   - Each report type's inserts are wrapped in a transaction for atomicity
 *   - Prepared statements are reused in loops for performance
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

export interface AggregateStatRow {
  scope_id: string;
  collected_at: number;
  report_type: string;
  stat_key: string;
  stat_value: number;
}


// =============================================================================
// Helpers
// =============================================================================

/** Convert ISO date string to unix epoch seconds. */
function toEpoch(dateStr: string): number {
  return Math.floor(new Date(dateStr).getTime() / 1000);
}

/** Round a unix epoch (seconds) down to the nearest hour. */
function toHourBucket(epoch: number): number {
  return epoch - (epoch % 3600);
}

/** Round an ISO date string to hourly bucket (unix epoch seconds). */
function isoToHourBucket(dateStr: string): number {
  return toHourBucket(toEpoch(dateStr));
}

/** Round an ISO date string to daily bucket (midnight UTC, unix epoch seconds). */
function isoDailyBucket(dateStr: string): number {
  const d = new Date(dateStr);
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/**
 * Parse a bot score range string like "0-9" into { start, end }.
 * Returns null if the format is unexpected.
 */
function parseBotScoreRange(range: string): { start: number; end: number } | null {
  const m = range.match(/^(\d+)-(\d+)/);
  if (!m) return null;
  return { start: parseInt(m[1], 10), end: parseInt(m[2], 10) };
}


// =============================================================================
// Shared insert helpers
// =============================================================================

function insertTopItems(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  reportType: string,
  category: string,
  items: Array<{ name: string; value: number; value2?: number; pct?: number; detail?: string }>,
): void {
  const stmt = db.prepare(`
    INSERT INTO top_items (scope_id, collected_at, report_type, category, rank, name, value, value2, value_pct, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    stmt.run(scopeId, collectedAt, reportType, category, i + 1, item.name, item.value, item.value2 ?? null, item.pct ?? null, item.detail ?? null);
  }
}

function insertAggregateStat(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  reportType: string,
  statKey: string,
  statValue: number,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO aggregate_stats (scope_id, collected_at, report_type, stat_key, stat_value)
    VALUES (?, ?, ?, ?, ?)
  `).run(scopeId, collectedAt, reportType, statKey, statValue);
}

function insertAggregateStats(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  reportType: string,
  stats: Record<string, number | undefined | null>,
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO aggregate_stats (scope_id, collected_at, report_type, stat_key, stat_value)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const [key, value] of Object.entries(stats)) {
    if (value != null && isFinite(value)) {
      stmt.run(scopeId, collectedAt, reportType, key, value);
    }
  }
}

function insertRecommendations(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  reportType: string,
  recs: Array<{ severity: string; title: string; description: string }>,
): void {
  const stmt = db.prepare(`
    INSERT INTO recommendations (scope_id, collected_at, report_type, severity, title, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const rec of recs) {
    stmt.run(scopeId, collectedAt, reportType, rec.severity, rec.title, rec.description);
  }
}

function insertProtocolDistribution(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  reportType: string,
  category: string,
  items: Array<{ name: string; requests: number }>,
): void {
  const stmt = db.prepare(`
    INSERT INTO protocol_distribution (scope_id, collected_at, report_type, category, name, requests)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const item of items) {
    stmt.run(scopeId, collectedAt, reportType, category, item.name, item.requests);
  }
}

function insertBotScoreDistribution(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  reportType: string,
  buckets: Array<{ range: string; count: number }>,
): void {
  const stmt = db.prepare(`
    INSERT INTO bot_score_distribution (scope_id, collected_at, report_type, range_start, range_end, count)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const bucket of buckets) {
    const parsed = parseBotScoreRange(bucket.range);
    if (parsed) {
      stmt.run(scopeId, collectedAt, reportType, parsed.start, parsed.end, bucket.count);
    }
  }
}


// =============================================================================
// 1. Executive
// =============================================================================

function storeExecutive(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: ExecutiveData,
): void {
  db.transaction(() => {
    // Aggregate stats: traffic
    insertAggregateStats(db, scopeId, collectedAt, "executive", {
      total_requests: data.traffic.totalRequests,
      total_bandwidth: data.traffic.totalBandwidth,
      cached_requests: data.traffic.cachedRequests,
      cache_hit_ratio: data.traffic.cacheHitRatio,
    });

    // Aggregate stats: security
    insertAggregateStats(db, scopeId, collectedAt, "executive", {
      total_threats_blocked: data.security.totalThreatsBlocked,
      ddos_mitigated: data.security.ddosMitigated,
    });

    // Aggregate stats: performance
    insertAggregateStats(db, scopeId, collectedAt, "executive", {
      ttfb_avg: data.performance.ttfb.avg,
      ttfb_p50: data.performance.ttfb.p50,
      ttfb_p95: data.performance.ttfb.p95,
      ttfb_p99: data.performance.ttfb.p99,
      origin_avg: data.performance.originResponseTime.avg,
      origin_p50: data.performance.originResponseTime.p50,
      origin_p95: data.performance.originResponseTime.p95,
      origin_p99: data.performance.originResponseTime.p99,
    });

    // Status code breakdown -> top_items
    insertTopItems(db, scopeId, collectedAt, "executive", "status_codes",
      data.statusCodeBreakdown.map((s) => ({ name: s.name, value: s.value })),
    );

    // Top countries -> top_items
    insertTopItems(db, scopeId, collectedAt, "executive", "top_countries",
      data.topCountries.map((c) => ({ name: c.name, value: c.value })),
    );

    // Recommendations
    insertRecommendations(db, scopeId, collectedAt, "executive", data.recommendations);
  })();
}


// =============================================================================
// 2. Security
// =============================================================================

function storeSecurity(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: SecurityEmailData,
): void {
  db.transaction(() => {
    // The server-side fetcher returns SecurityEmailData (simplified for emails),
    // not the rich SecurityData from browser queries.

    // Aggregate stats
    insertAggregateStats(db, scopeId, collectedAt, "security", {
      total_threats_blocked: data.totalThreatsBlocked,
      challenge_solve_rate: data.challengeSolveRate,
    });

    // Top sources -> top_items
    if (data.topSources) {
      insertTopItems(db, scopeId, collectedAt, "security", "source_breakdown",
        data.topSources.map((s) => ({ name: s.name, value: s.value })),
      );
    }

    // Top block rules -> top_items (no ruleId available in email format)
    if (data.topBlockRules) {
      insertTopItems(db, scopeId, collectedAt, "security", "top_block_rules",
        data.topBlockRules.map((r) => ({ name: r.name, value: r.count })),
      );
    }

    // Top attacking IPs -> top_items
    if (data.topAttackingIPs) {
      insertTopItems(db, scopeId, collectedAt, "security", "top_attacking_ips",
        data.topAttackingIPs.map((ip) => ({ name: ip.ip, value: ip.count })),
      );
    }

    // Top attacking countries -> top_items
    if (data.topAttackingCountries) {
      insertTopItems(db, scopeId, collectedAt, "security", "top_attacking_countries",
        data.topAttackingCountries.map((c) => ({ name: c.country, value: c.count })),
      );
    }
  })();
}


// =============================================================================
// 3. Traffic
// =============================================================================

function storeTraffic(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: TrafficData,
): void {
  db.transaction(() => {
    // Time series -> http_requests_ts
    const tsStmt = db.prepare(`
      INSERT OR REPLACE INTO http_requests_ts (zone_id, ts, requests, bandwidth, cached_requests, cached_bandwidth, encrypted_requests, status_1xx, status_2xx, status_3xx, status_4xx, status_5xx, avg_ttfb_ms, p95_ttfb_ms, avg_origin_time_ms, p95_origin_time_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Build lookup maps for error trend and bandwidth-by-cache data
    const errorByHour = new Map<number, { s4xx: number; s5xx: number }>();
    for (const pt of data.errorTrend) {
      const ts = isoToHourBucket(pt.date);
      errorByHour.set(ts, { s4xx: pt["4xx"], s5xx: pt["5xx"] });
    }

    const bwByHour = new Map<number, { cached: number; uncached: number }>();
    for (const pt of data.bandwidthByCache) {
      const ts = isoToHourBucket(pt.date);
      bwByHour.set(ts, { cached: pt.cached, uncached: pt.uncached });
    }

    for (const pt of data.timeSeries) {
      const ts = isoToHourBucket(pt.date);
      const errors = errorByHour.get(ts);
      const bw = bwByHour.get(ts);
      tsStmt.run(
        scopeId, ts,
        pt.requests, pt.bandwidth, pt.cachedRequests,
        bw?.cached ?? 0,  // cached_bandwidth
        0,                 // encrypted_requests (filled by SSL report)
        0,                 // status_1xx
        0,                 // status_2xx (could be derived but not directly available per hour)
        0,                 // status_3xx
        errors?.s4xx ?? 0, // status_4xx
        errors?.s5xx ?? 0, // status_5xx
        null, null, null, null, // TTFB/origin (filled by performance report)
      );
    }

    // Status codes -> top_items
    insertTopItems(db, scopeId, collectedAt, "traffic", "status_codes",
      data.statusCodes.map((s) => ({ name: s.name, value: s.value })),
    );

    // Top paths -> top_items
    insertTopItems(db, scopeId, collectedAt, "traffic", "top_paths",
      data.topPaths.map((p) => ({ name: p.name, value: p.value })),
    );

    // Top countries -> top_items
    insertTopItems(db, scopeId, collectedAt, "traffic", "top_countries",
      data.topCountries.map((c) => ({ name: c.name, value: c.value })),
    );

    // Cache stats -> aggregate_stats
    insertAggregateStats(db, scopeId, collectedAt, "traffic", {
      cache_hit: data.cache.hit,
      cache_miss: data.cache.miss,
      cache_total: data.cache.total,
      cache_ratio: data.cache.ratio,
      total_requests: data.totalRequests,
      total_bandwidth: data.totalBandwidth,
    });

    // Content types -> top_items
    insertTopItems(db, scopeId, collectedAt, "traffic", "content_types",
      data.contentTypes.map((c) => ({ name: c.name, value: c.value })),
    );
  })();
}


// =============================================================================
// 4. Performance
// =============================================================================

function storePerformance(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: PerformanceData,
): void {
  db.transaction(() => {
    // Time series -> http_requests_ts (avg_ttfb_ms, avg_origin_time_ms columns)
    // Use INSERT OR REPLACE with COALESCE to preserve traffic data columns
    const tsStmt = db.prepare(`
      INSERT OR REPLACE INTO http_requests_ts (zone_id, ts, requests, bandwidth, cached_requests, cached_bandwidth, encrypted_requests, status_1xx, status_2xx, status_3xx, status_4xx, status_5xx, avg_ttfb_ms, p95_ttfb_ms, avg_origin_time_ms, p95_origin_time_ms)
      VALUES (?, ?,
        COALESCE((SELECT requests FROM http_requests_ts WHERE zone_id = ? AND ts = ?), ?),
        COALESCE((SELECT bandwidth FROM http_requests_ts WHERE zone_id = ? AND ts = ?), 0),
        COALESCE((SELECT cached_requests FROM http_requests_ts WHERE zone_id = ? AND ts = ?), 0),
        COALESCE((SELECT cached_bandwidth FROM http_requests_ts WHERE zone_id = ? AND ts = ?), 0),
        COALESCE((SELECT encrypted_requests FROM http_requests_ts WHERE zone_id = ? AND ts = ?), 0),
        COALESCE((SELECT status_1xx FROM http_requests_ts WHERE zone_id = ? AND ts = ?), 0),
        COALESCE((SELECT status_2xx FROM http_requests_ts WHERE zone_id = ? AND ts = ?), 0),
        COALESCE((SELECT status_3xx FROM http_requests_ts WHERE zone_id = ? AND ts = ?), 0),
        COALESCE((SELECT status_4xx FROM http_requests_ts WHERE zone_id = ? AND ts = ?), 0),
        COALESCE((SELECT status_5xx FROM http_requests_ts WHERE zone_id = ? AND ts = ?), 0),
        ?, ?, ?, ?)
    `);

    for (const pt of data.timeSeries) {
      const ts = isoToHourBucket(pt.date);
      tsStmt.run(
        scopeId, ts,
        scopeId, ts, pt.requests,
        scopeId, ts,
        scopeId, ts,
        scopeId, ts,
        scopeId, ts,
        scopeId, ts,
        scopeId, ts,
        scopeId, ts,
        scopeId, ts,
        scopeId, ts,
        pt.avgTtfb, null, pt.avgOriginTime, null,
      );
    }

    // Content type performance -> performance_breakdown
    const perfStmt = db.prepare(`
      INSERT INTO performance_breakdown (zone_id, collected_at, dimension, name, city, country, requests, avg_ttfb_ms, avg_origin_time_ms, avg_response_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const ct of data.contentTypePerf) {
      perfStmt.run(scopeId, collectedAt, "content_type", ct.contentType, null, null, ct.requests, ct.avgTtfb, ct.avgOriginTime, ct.avgResponseBytes);
    }

    // Country performance -> performance_breakdown
    for (const cp of data.countryPerf) {
      perfStmt.run(scopeId, collectedAt, "country", cp.country, null, null, cp.requests, cp.avgTtfb, cp.avgOriginTime, null);
    }

    // Protocol distribution -> protocol_distribution
    insertProtocolDistribution(db, scopeId, collectedAt, "performance", "http_protocol",
      data.protocolDistribution.map((p) => ({ name: p.protocol, requests: p.requests })),
    );

    // Colo performance -> performance_breakdown
    for (const colo of data.coloPerf) {
      perfStmt.run(scopeId, collectedAt, "colo", colo.colo, colo.city, colo.country, colo.requests, colo.avgTtfb, null, null);
    }

    // Stats -> aggregate_stats
    insertAggregateStats(db, scopeId, collectedAt, "performance", {
      total_requests: data.stats.totalRequests,
      avg_ttfb: data.stats.avgTtfb,
      p95_ttfb: data.stats.p95Ttfb,
      avg_origin_time: data.stats.avgOriginTime,
      p95_origin_time: data.stats.p95OriginTime,
      total_bytes: data.stats.totalBytes,
    });
  })();
}


// =============================================================================
// 5. DNS
// =============================================================================

function storeDns(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: DnsData,
): void {
  db.transaction(() => {
    // Query volume by type -> dns_queries_ts (one row per type per hour)
    const dnsStmt = db.prepare(`
      INSERT OR REPLACE INTO dns_queries_ts (zone_id, ts, query_type, count)
      VALUES (?, ?, ?, ?)
    `);
    for (const pt of data.queryVolumeByType) {
      const ts = pt.date.includes("T") ? isoToHourBucket(pt.date) : isoDailyBucket(pt.date);
      for (const [key, value] of Object.entries(pt)) {
        if (key === "date" || typeof value !== "number") continue;
        dnsStmt.run(scopeId, ts, key, value);
      }
    }

    // Response code breakdown -> top_items
    insertTopItems(db, scopeId, collectedAt, "dns", "response_codes",
      data.responseCodeBreakdown.map((r) => ({ name: r.name, value: r.value })),
    );

    // DNS records -> dns_records
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

    // Top queried records -> top_items
    insertTopItems(db, scopeId, collectedAt, "dns", "top_queried_records",
      data.topQueriedRecords.map((r) => ({ name: r.name, value: r.count })),
    );

    // NXDOMAIN hotspots -> top_items
    insertTopItems(db, scopeId, collectedAt, "dns", "nxdomain_hotspots",
      data.nxdomainHotspots.map((r) => ({ name: r.name, value: r.count })),
    );

    // Total queries -> aggregate_stats
    insertAggregateStat(db, scopeId, collectedAt, "dns", "total_queries", data.totalQueries);

    // Latency -> aggregate_stats
    insertAggregateStats(db, scopeId, collectedAt, "dns", {
      latency_avg: data.latency.avg,
      latency_p50: data.latency.p50,
      latency_p90: data.latency.p90,
      latency_p99: data.latency.p99,
    });
  })();
}


// =============================================================================
// 6. Origin Health
// =============================================================================

function storeOriginHealth(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: OriginHealthData,
): void {
  db.transaction(() => {
    // Status breakdown -> origin_status_breakdown
    const statusStmt = db.prepare(`
      INSERT INTO origin_status_breakdown (zone_id, collected_at, status_code, status_group, requests, avg_response_time_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const sb of data.statusBreakdown) {
      statusStmt.run(scopeId, collectedAt, sb.status, sb.statusGroup, sb.requests, sb.avgResponseTime);
    }

    // Time series -> origin_health_ts
    const tsStmt = db.prepare(`
      INSERT OR REPLACE INTO origin_health_ts (zone_id, ts, requests, avg_response_time_ms, error_rate)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const pt of data.timeSeries) {
      const ts = isoToHourBucket(pt.date);
      tsStmt.run(scopeId, ts, pt.requests, pt.avgResponseTime, pt.errorRate);
    }

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

    // Stats -> aggregate_stats
    insertAggregateStats(db, scopeId, collectedAt, "origin-health", {
      total_requests: data.stats.totalRequests,
      avg_response_time: data.stats.avgResponseTime,
      p95_response_time: data.stats.p95ResponseTime,
      error_rate_5xx: data.stats.errorRate5xx,
      origin_statuses: data.stats.originStatuses,
    });
  })();
}


// =============================================================================
// 7. SSL
// =============================================================================

function storeSsl(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: SslData,
): void {
  db.transaction(() => {
    // TLS versions -> protocol_distribution
    insertProtocolDistribution(db, scopeId, collectedAt, "ssl", "tls_version",
      data.tlsVersions.map((t) => ({ name: t.version, requests: t.requests })),
    );

    // HTTP protocols -> protocol_distribution
    insertProtocolDistribution(db, scopeId, collectedAt, "ssl", "http_protocol",
      data.httpProtocols.map((p) => ({ name: p.protocol, requests: p.requests })),
    );

    // Protocol matrix -> protocol_distribution
    insertProtocolDistribution(db, scopeId, collectedAt, "ssl", "tls_http_matrix",
      data.protocolMatrix.map((m) => ({
        name: `${m.tlsVersion}+${m.httpProtocol}`,
        requests: m.requests,
      })),
    );

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

    // Encryption time series -> http_requests_ts (encrypted_requests column)
    // Use INSERT OR REPLACE with COALESCE to preserve existing columns
    const encStmt = db.prepare(`
      INSERT OR REPLACE INTO http_requests_ts (zone_id, ts, requests, bandwidth, cached_requests, cached_bandwidth, encrypted_requests, status_1xx, status_2xx, status_3xx, status_4xx, status_5xx, avg_ttfb_ms, p95_ttfb_ms, avg_origin_time_ms, p95_origin_time_ms)
      VALUES (?, ?,
        COALESCE((SELECT requests FROM http_requests_ts WHERE zone_id = ? AND ts = ?), ?),
        COALESCE((SELECT bandwidth FROM http_requests_ts WHERE zone_id = ? AND ts = ?), 0),
        COALESCE((SELECT cached_requests FROM http_requests_ts WHERE zone_id = ? AND ts = ?), 0),
        COALESCE((SELECT cached_bandwidth FROM http_requests_ts WHERE zone_id = ? AND ts = ?), 0),
        ?,
        COALESCE((SELECT status_1xx FROM http_requests_ts WHERE zone_id = ? AND ts = ?), 0),
        COALESCE((SELECT status_2xx FROM http_requests_ts WHERE zone_id = ? AND ts = ?), 0),
        COALESCE((SELECT status_3xx FROM http_requests_ts WHERE zone_id = ? AND ts = ?), 0),
        COALESCE((SELECT status_4xx FROM http_requests_ts WHERE zone_id = ? AND ts = ?), 0),
        COALESCE((SELECT status_5xx FROM http_requests_ts WHERE zone_id = ? AND ts = ?), 0),
        COALESCE((SELECT avg_ttfb_ms FROM http_requests_ts WHERE zone_id = ? AND ts = ?), NULL),
        COALESCE((SELECT p95_ttfb_ms FROM http_requests_ts WHERE zone_id = ? AND ts = ?), NULL),
        COALESCE((SELECT avg_origin_time_ms FROM http_requests_ts WHERE zone_id = ? AND ts = ?), NULL),
        COALESCE((SELECT p95_origin_time_ms FROM http_requests_ts WHERE zone_id = ? AND ts = ?), NULL))
    `);
    for (const pt of data.encryptionTimeSeries) {
      const ts = isoToHourBucket(pt.date);
      encStmt.run(
        scopeId, ts,
        scopeId, ts, pt.totalRequests,
        scopeId, ts,
        scopeId, ts,
        scopeId, ts,
        pt.encryptedRequests,
        scopeId, ts,
        scopeId, ts,
        scopeId, ts,
        scopeId, ts,
        scopeId, ts,
        scopeId, ts,
        scopeId, ts,
        scopeId, ts,
        scopeId, ts,
      );
    }

    // Stats -> aggregate_stats
    insertAggregateStats(db, scopeId, collectedAt, "ssl", {
      total_requests: data.stats.totalRequests,
      encrypted_requests: data.stats.encryptedRequests,
      encrypted_percent: data.stats.encryptedPercent,
      tlsv13_percent: data.stats.tlsv13Percent,
      http3_percent: data.stats.http3Percent,
      cert_count: data.stats.certCount,
    });
  })();
}


// =============================================================================
// 8. Bots
// =============================================================================

function storeBots(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: BotData,
): void {
  db.transaction(() => {
    // Bot score distribution
    insertBotScoreDistribution(db, scopeId, collectedAt, "bots", data.botScoreDistribution);

    // Bot management decisions -> top_items
    insertTopItems(db, scopeId, collectedAt, "bots", "bot_decisions",
      data.botManagementDecisions.map((d) => ({ name: d.name, value: d.value })),
    );

    // Bot traffic over time -> bot_traffic_ts
    const btStmt = db.prepare(`
      INSERT OR REPLACE INTO bot_traffic_ts (zone_id, ts, automated, verified_bot, unverified_bot, human, total)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // Build a map from botTrend (which has verified/unverified/human breakdown)
    const trendByHour = new Map<number, { verified: number; unverified: number; human: number }>();
    for (const pt of data.botTrend) {
      const ts = isoToHourBucket(pt.date);
      trendByHour.set(ts, { verified: pt.verified, unverified: pt.unverified, human: pt.human });
    }

    // automatedTrafficOverTime has automated and total counts
    for (const pt of data.automatedTrafficOverTime) {
      const ts = isoToHourBucket(pt.date);
      const trend = trendByHour.get(ts);
      btStmt.run(
        scopeId, ts,
        pt.automated,
        trend?.verified ?? 0,
        trend?.unverified ?? 0,
        trend?.human ?? (pt.total - pt.automated),
        pt.total,
      );
    }

    // If automatedTrafficOverTime is empty but botTrend has data, use botTrend
    if (data.automatedTrafficOverTime.length === 0) {
      for (const pt of data.botTrend) {
        const ts = isoToHourBucket(pt.date);
        const automated = pt.verified + pt.unverified;
        btStmt.run(scopeId, ts, automated, pt.verified, pt.unverified, pt.human, automated + pt.human);
      }
    }

    // Top bot user agents -> top_items
    insertTopItems(db, scopeId, collectedAt, "bots", "top_bot_user_agents",
      data.topBotUserAgents.map((ua) => ({ name: ua.userAgent, value: ua.count })),
    );

    // Bot requests by path -> top_items
    insertTopItems(db, scopeId, collectedAt, "bots", "bot_requests_by_path",
      data.botRequestsByPath.map((p) => ({ name: p.path, value: p.count })),
    );

    // Verified bot categories -> top_items
    insertTopItems(db, scopeId, collectedAt, "bots", "verified_bot_categories",
      data.verifiedBotCategories.map((c) => ({ name: c.category, value: c.count })),
    );

    // Verified/unverified totals -> aggregate_stats
    insertAggregateStats(db, scopeId, collectedAt, "bots", {
      verified_bot_total: data.verifiedBotTotal,
      unverified_bot_total: data.unverifiedBotTotal,
    });
  })();
}


// =============================================================================
// 9. API Shield
// =============================================================================

function storeApiShield(
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

    // Method distribution -> top_items
    insertTopItems(db, scopeId, collectedAt, "api-shield", "method_distribution",
      data.methodDistribution.map((m) => ({ name: m.method, value: m.count })),
    );

    // Session traffic -> api_session_ts
    const sessStmt = db.prepare(`
      INSERT OR REPLACE INTO api_session_ts (zone_id, ts, authenticated, unauthenticated)
      VALUES (?, ?, ?, ?)
    `);
    for (const pt of data.sessionTraffic) {
      const ts = isoToHourBucket(pt.date);
      sessStmt.run(scopeId, ts, pt.authenticated, pt.unauthenticated);
    }

    // Top endpoint traffic -> top_items
    insertTopItems(db, scopeId, collectedAt, "api-shield", "top_endpoint_traffic",
      data.topEndpointTraffic.map((ep) => ({
        name: ep.endpointPath,
        value: ep.requests,
        value2: ep.status2xx,
        detail: `4xx:${ep.status4xx},5xx:${ep.status5xx}`,
      })),
    );

    // Stats -> aggregate_stats
    insertAggregateStats(db, scopeId, collectedAt, "api-shield", {
      total_managed: data.stats.totalManaged,
      total_discovered: data.stats.totalDiscovered,
      discovered_in_review: data.stats.discoveredInReview,
      avg_requests_per_hour: data.stats.avgRequestsPerHour,
    });
  })();
}


// =============================================================================
// 10. DDoS
// =============================================================================

function storeDdos(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: DdosData,
): void {
  db.transaction(() => {
    // DDoS + rate limit events over time -> ddos_events_ts
    // Combine both into a single map keyed by hourly bucket
    const tsMap = new Map<number, { l7: number; rl: number }>();
    for (const pt of data.ddosEventsOverTime) {
      const ts = isoToHourBucket(pt.date);
      const existing = tsMap.get(ts) || { l7: 0, rl: 0 };
      existing.l7 += pt.count;
      tsMap.set(ts, existing);
    }
    for (const pt of data.rateLimitEventsOverTime) {
      const ts = isoToHourBucket(pt.date);
      const existing = tsMap.get(ts) || { l7: 0, rl: 0 };
      existing.rl += pt.count;
      tsMap.set(ts, existing);
    }

    const ddosStmt = db.prepare(`
      INSERT OR REPLACE INTO ddos_events_ts (zone_id, ts, l7_ddos_count, rate_limit_count)
      VALUES (?, ?, ?, ?)
    `);
    for (const [ts, counts] of tsMap) {
      ddosStmt.run(scopeId, ts, counts.l7, counts.rl);
    }

    // DDoS attack vectors -> top_items
    insertTopItems(db, scopeId, collectedAt, "ddos", "ddos_attack_vectors",
      data.ddosAttackVectors.map((v) => ({ name: v.method, value: v.count })),
    );

    // DDoS top paths -> top_items
    insertTopItems(db, scopeId, collectedAt, "ddos", "ddos_top_paths",
      data.ddosTopPaths.map((p) => ({ name: p.path, value: p.count })),
    );

    // Total DDoS events -> aggregate_stats
    insertAggregateStat(db, scopeId, collectedAt, "ddos", "total_ddos_events", data.totalDdosEvents);

    // Rate limit methods -> top_items
    insertTopItems(db, scopeId, collectedAt, "ddos", "rate_limit_methods",
      data.rateLimitMethods.map((m) => ({ name: m.method, value: m.count })),
    );

    // Rate limit top paths -> top_items
    insertTopItems(db, scopeId, collectedAt, "ddos", "rate_limit_top_paths",
      data.rateLimitTopPaths.map((p) => ({ name: p.path, value: p.count })),
    );

    // Total rate limit events -> aggregate_stats
    insertAggregateStat(db, scopeId, collectedAt, "ddos", "total_rate_limit_events", data.totalRateLimitEvents);

    // L3/L4 attacks -> ddos_l34_attacks
    if (data.l34) {
      const l34Stmt = db.prepare(`
        INSERT INTO ddos_l34_attacks (zone_id, collected_at, attack_type, attack_vector, ip_protocol, destination_port, mitigation_type, packets, bits, dropped_packets, dropped_bits, start_time, end_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const atk of data.l34.attacks) {
        l34Stmt.run(
          scopeId, collectedAt,
          atk.attackType, atk.attackVector, atk.ipProtocol, atk.destinationPort,
          atk.mitigationType, atk.packets, atk.bits, atk.droppedPackets, atk.droppedBits,
          toEpoch(atk.start), toEpoch(atk.end),
        );
      }

      // L3/L4 totals -> aggregate_stats
      insertAggregateStats(db, scopeId, collectedAt, "ddos", {
        l34_total_attacks: data.l34.totalAttacks,
        l34_total_packets_dropped: data.l34.totalPacketsDropped,
        l34_total_bits_dropped: data.l34.totalBitsDropped,
      });
    }
  })();
}


// =============================================================================
// 11. Gateway DNS
// =============================================================================

function storeGatewayDns(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: GatewayDnsData,
): void {
  db.transaction(() => {
    // Query volume -> gateway_dns_ts
    const gwDnsStmt = db.prepare(`
      INSERT OR REPLACE INTO gateway_dns_ts (account_id, ts, count)
      VALUES (?, ?, ?)
    `);
    for (const pt of data.queryVolume) {
      const ts = isoToHourBucket(pt.date);
      gwDnsStmt.run(scopeId, ts, pt.count);
    }

    // Top blocked domains -> top_items
    insertTopItems(db, scopeId, collectedAt, "gateway-dns", "top_blocked_domains",
      data.topBlockedDomains.map((d) => ({ name: d.domain, value: d.count, detail: d.category })),
    );

    // Blocked categories -> top_items
    insertTopItems(db, scopeId, collectedAt, "gateway-dns", "blocked_categories",
      data.blockedCategories.map((c) => ({ name: c.category, value: c.count })),
    );

    // Resolver decisions -> top_items
    insertTopItems(db, scopeId, collectedAt, "gateway-dns", "resolver_decisions",
      data.resolverDecisions.map((d) => ({ name: d.decision, value: d.count })),
    );

    // Top blocked locations -> top_items
    insertTopItems(db, scopeId, collectedAt, "gateway-dns", "top_blocked_locations",
      data.topBlockedLocations.map((l) => ({ name: l.location, value: l.count })),
    );

    // Policy breakdown -> gateway_policies
    const policyStmt = db.prepare(`
      INSERT INTO gateway_policies (account_id, collected_at, policy_name, allowed, blocked, total)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const p of data.policyBreakdown) {
      policyStmt.run(scopeId, collectedAt, p.policyName, p.allowed, p.blocked, p.total);
    }

    // Location breakdown -> top_items
    insertTopItems(db, scopeId, collectedAt, "gateway-dns", "location_breakdown",
      data.locationBreakdown.map((l) => ({ name: l.location, value: l.total, value2: l.blocked })),
    );

    // HTTP inspection
    if (data.httpInspection) {
      // HTTP inspection time series -> gateway_http_ts
      const httpStmt = db.prepare(`
        INSERT OR REPLACE INTO gateway_http_ts (account_id, ts, count)
        VALUES (?, ?, ?)
      `);
      for (const pt of data.httpInspection.timeSeries) {
        const ts = isoToHourBucket(pt.date);
        httpStmt.run(scopeId, ts, pt.count);
      }

      // HTTP top hosts -> top_items
      insertTopItems(db, scopeId, collectedAt, "gateway-dns", "http_top_hosts",
        data.httpInspection.topHosts.map((h) => ({ name: h.host, value: h.count })),
      );

      // HTTP actions -> top_items
      insertTopItems(db, scopeId, collectedAt, "gateway-dns", "http_actions",
        data.httpInspection.byAction.map((a) => ({ name: a.action, value: a.count })),
      );
    }
  })();
}


// =============================================================================
// 12. Gateway Network
// =============================================================================

function storeGatewayNetwork(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: GatewayNetworkData,
): void {
  db.transaction(() => {
    // Sessions over time -> gateway_network_ts
    const netStmt = db.prepare(`
      INSERT OR REPLACE INTO gateway_network_ts (account_id, ts, allowed, blocked)
      VALUES (?, ?, ?, ?)
    `);
    for (const pt of data.sessionsOverTime) {
      const ts = isoToHourBucket(pt.date);
      netStmt.run(scopeId, ts, pt.allowed, pt.blocked);
    }

    // Blocked destinations -> gateway_blocked_destinations
    const destStmt = db.prepare(`
      INSERT INTO gateway_blocked_destinations (account_id, collected_at, ip, count, country, port, protocol)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const d of data.blockedDestinations) {
      destStmt.run(scopeId, collectedAt, d.ip, d.count, d.country, d.port, d.protocol);
    }

    // Top source countries -> top_items
    insertTopItems(db, scopeId, collectedAt, "gateway-network", "top_source_countries",
      data.topSourceCountries.map((c) => ({ name: c.country, value: c.count })),
    );

    // Transport protocols -> protocol_distribution
    insertProtocolDistribution(db, scopeId, collectedAt, "gateway-network", "transport",
      data.transportProtocols.map((p) => ({ name: p.protocol, requests: p.count })),
    );

    // Port breakdown -> top_items
    insertTopItems(db, scopeId, collectedAt, "gateway-network", "port_breakdown",
      data.portBreakdown.map((p) => ({ name: `${p.port} (${p.service})`, value: p.count })),
    );
  })();
}


// =============================================================================
// 13. Shadow IT
// =============================================================================

function storeShadowIt(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: ShadowItData,
): void {
  db.transaction(() => {
    // Discovered applications -> shadow_it_apps
    const appStmt = db.prepare(`
      INSERT INTO shadow_it_apps (account_id, collected_at, app_name, raw_name, category, count)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const app of data.discoveredApplications) {
      appStmt.run(scopeId, collectedAt, app.name, app.rawName, app.category, app.count);
    }

    // Category breakdown -> top_items
    insertTopItems(db, scopeId, collectedAt, "shadow-it", "category_breakdown",
      data.categoryBreakdown.map((c) => ({ name: c.category, value: c.count })),
    );

    // Usage trends -> shadow_it_usage_ts
    const trendStmt = db.prepare(`
      INSERT OR REPLACE INTO shadow_it_usage_ts (account_id, ts, app_name, count)
      VALUES (?, ?, ?, ?)
    `);
    for (const pt of data.usageTrends) {
      const ts = pt.date.includes("T") ? isoToHourBucket(pt.date) : isoDailyBucket(pt.date);
      for (const [key, value] of Object.entries(pt)) {
        if (key === "date" || typeof value !== "number") continue;
        trendStmt.run(scopeId, ts, key, value);
      }
    }

    // User-app mappings -> shadow_it_user_apps
    const userStmt = db.prepare(`
      INSERT INTO shadow_it_user_apps (account_id, collected_at, email, apps, total_requests)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const mapping of data.userAppMappings) {
      userStmt.run(scopeId, collectedAt, mapping.email, JSON.stringify(mapping.apps), mapping.totalRequests);
    }

    // onlyBlockedLogged -> aggregate_stats
    insertAggregateStat(db, scopeId, collectedAt, "shadow-it", "only_blocked_logged", data.onlyBlockedLogged ? 1 : 0);
  })();
}


// =============================================================================
// 14. Devices & Users
// =============================================================================

function storeDevicesUsers(
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

    // OS distribution -> top_items
    insertTopItems(db, scopeId, collectedAt, "devices-users", "os_distribution",
      data.osDistribution.map((o) => ({ name: o.name, value: o.value })),
    );

    // WARP version distribution -> top_items
    insertTopItems(db, scopeId, collectedAt, "devices-users", "warp_versions",
      data.warpVersionDistribution.map((w) => ({ name: w.name, value: w.value })),
    );

    // Stats -> aggregate_stats
    insertAggregateStats(db, scopeId, collectedAt, "devices-users", {
      total_devices: data.stats.totalDevices,
      active_devices: data.stats.activeDevices,
      inactive_devices: data.stats.inactiveDevices,
      stale_devices: data.stats.staleDevices,
      total_users: data.stats.totalUsers,
      access_seats: data.stats.accessSeats,
      gateway_seats: data.stats.gatewaySeats,
    });

    // Health metrics -> aggregate_stats (each health metric as a stat_key)
    for (const h of data.health) {
      const key = `health_${h.label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
      insertAggregateStat(db, scopeId, collectedAt, "devices-users", key, h.value);
    }
  })();
}


// =============================================================================
// 15. ZT Summary
// =============================================================================

function storeZtSummary(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: ZtSummaryData,
): void {
  db.transaction(() => {
    // DNS query totals -> aggregate_stats
    insertAggregateStats(db, scopeId, collectedAt, "zt-summary", {
      total_dns_queries: data.totalDnsQueries,
      blocked_dns_queries: data.blockedDnsQueries,
    });

    // Resolver decisions -> top_items
    insertTopItems(db, scopeId, collectedAt, "zt-summary", "resolver_decisions",
      data.resolverDecisions.map((d) => ({ name: d.decision, value: d.count, detail: String(d.id) })),
    );

    // Blocked by policy -> top_items
    insertTopItems(db, scopeId, collectedAt, "zt-summary", "blocked_by_policy",
      data.blockedByPolicy.map((p) => ({ name: p.name, value: p.value })),
    );

    // Top blocked categories -> top_items
    insertTopItems(db, scopeId, collectedAt, "zt-summary", "top_blocked_categories",
      data.topBlockedCategories.map((c) => ({ name: c.name, value: c.value })),
    );

    // Access logins -> aggregate_stats
    insertAggregateStats(db, scopeId, collectedAt, "zt-summary", {
      access_logins_total: data.accessLogins.total,
      access_logins_successful: data.accessLogins.successful,
    });

    // Fleet stats -> aggregate_stats
    insertAggregateStats(db, scopeId, collectedAt, "zt-summary", {
      fleet_total_devices: data.fleet.totalDevices,
      fleet_active_devices: data.fleet.activeDevices,
      fleet_total_users: data.fleet.totalUsers,
      fleet_access_seats: data.fleet.accessSeats,
      fleet_gateway_seats: data.fleet.gatewaySeats,
      fleet_access_apps: data.fleet.accessApps,
    });

    // Daily active users -> daily_active_users_ts
    const dauStmt = db.prepare(`
      INSERT OR REPLACE INTO daily_active_users_ts (account_id, ts, unique_users, logins)
      VALUES (?, ?, ?, ?)
    `);
    for (const pt of data.dailyActiveUsers) {
      const ts = isoDailyBucket(pt.date);
      dauStmt.run(scopeId, ts, pt.uniqueUsers, pt.logins);
    }

    // Compliance metrics -> aggregate_stats
    for (const c of data.compliance) {
      const key = `compliance_${c.label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
      insertAggregateStat(db, scopeId, collectedAt, "zt-summary", key, c.value);
    }
  })();
}


// =============================================================================
// 16. Access Audit
// =============================================================================

function storeAccessAudit(
  db: Database.Database,
  scopeId: string,
  collectedAt: number,
  data: AccessAuditData,
): void {
  db.transaction(() => {
    // Logins over time -> access_logins_ts
    const loginStmt = db.prepare(`
      INSERT OR REPLACE INTO access_logins_ts (account_id, ts, successful, failed)
      VALUES (?, ?, ?, ?)
    `);
    for (const pt of data.loginsOverTime) {
      const ts = isoDailyBucket(pt.date);
      loginStmt.run(scopeId, ts, pt.successful, pt.failed);
    }

    // Access by application -> top_items
    insertTopItems(db, scopeId, collectedAt, "access-audit", "access_by_application",
      data.accessByApplication.map((a) => ({
        name: a.appName || a.appId,
        value: a.count,
        detail: a.appId,
      })),
    );

    // App breakdown -> access_app_stats
    const appStmt = db.prepare(`
      INSERT INTO access_app_stats (account_id, collected_at, app_id, app_name, successful, failed, total, failure_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const app of data.appBreakdown) {
      appStmt.run(scopeId, collectedAt, app.appId, app.appName || app.appId, app.successful, app.failed, app.total, app.failureRate);
    }

    // Geographic access -> top_items
    insertTopItems(db, scopeId, collectedAt, "access-audit", "geographic_access",
      data.geographicAccess.map((g) => ({ name: g.country, value: g.count })),
    );

    // Identity providers -> top_items
    insertTopItems(db, scopeId, collectedAt, "access-audit", "identity_providers",
      data.identityProviders.map((ip) => ({ name: ip.provider, value: ip.count })),
    );

    // Failed login count -> aggregate_stats
    insertAggregateStat(db, scopeId, collectedAt, "access-audit", "failed_login_count", data.failedLoginCount);

    // Failed login details -> top_items
    insertTopItems(db, scopeId, collectedAt, "access-audit", "failed_login_details",
      data.failedLoginDetails.map((d) => ({
        name: d.appName || d.appId,
        value: d.count,
        detail: `country:${d.country},idp:${d.identityProvider}`,
      })),
    );

    // Failed by app -> top_items
    insertTopItems(db, scopeId, collectedAt, "access-audit", "failed_by_app",
      data.failedByApp.map((a) => ({
        name: a.appName || a.appId,
        value: a.count,
        detail: a.appId,
      })),
    );

    // Failed by country -> top_items
    insertTopItems(db, scopeId, collectedAt, "access-audit", "failed_by_country",
      data.failedByCountry.map((c) => ({ name: c.country, value: c.count })),
    );

    // Anomalies -> recommendations
    insertRecommendations(db, scopeId, collectedAt, "access-audit", data.anomalies);
  })();
}


// =============================================================================
// Report type dispatcher map
// =============================================================================

const STORE_FUNCTIONS: Record<string, (db: Database.Database, scopeId: string, collectedAt: number, data: unknown) => void> = {
  executive:         (db, s, c, d) => storeExecutive(db, s, c, d as ExecutiveData),
  security:          (db, s, c, d) => storeSecurity(db, s, c, d as SecurityEmailData),
  traffic:           (db, s, c, d) => storeTraffic(db, s, c, d as TrafficData),
  performance:       (db, s, c, d) => storePerformance(db, s, c, d as PerformanceData),
  dns:               (db, s, c, d) => storeDns(db, s, c, d as DnsData),
  "origin-health":   (db, s, c, d) => storeOriginHealth(db, s, c, d as OriginHealthData),
  ssl:               (db, s, c, d) => storeSsl(db, s, c, d as SslData),
  bots:              (db, s, c, d) => storeBots(db, s, c, d as BotData),
  "api-shield":      (db, s, c, d) => storeApiShield(db, s, c, d as ApiShieldData),
  ddos:              (db, s, c, d) => storeDdos(db, s, c, d as DdosData),
  "gateway-dns":     (db, s, c, d) => storeGatewayDns(db, s, c, d as GatewayDnsData),
  "gateway-network": (db, s, c, d) => storeGatewayNetwork(db, s, c, d as GatewayNetworkData),
  "shadow-it":       (db, s, c, d) => storeShadowIt(db, s, c, d as ShadowItData),
  "devices-users":   (db, s, c, d) => storeDevicesUsers(db, s, c, d as DevicesUsersData),
  "zt-summary":      (db, s, c, d) => storeZtSummary(db, s, c, d as ZtSummaryData),
  "access-audit":    (db, s, c, d) => storeAccessAudit(db, s, c, d as AccessAuditData),
};

/** Table + query to find the last timestamp, keyed by report type. */
const LAST_TS_QUERIES: Record<string, string> = {
  executive:         "SELECT MAX(ts) as max_ts FROM http_requests_ts WHERE zone_id = ?",
  security:          "SELECT MAX(ts) as max_ts FROM firewall_events_ts WHERE zone_id = ?",
  traffic:           "SELECT MAX(ts) as max_ts FROM http_requests_ts WHERE zone_id = ?",
  performance:       "SELECT MAX(ts) as max_ts FROM http_requests_ts WHERE zone_id = ?",
  dns:               "SELECT MAX(ts) as max_ts FROM dns_queries_ts WHERE zone_id = ?",
  "origin-health":   "SELECT MAX(ts) as max_ts FROM origin_health_ts WHERE zone_id = ?",
  ssl:               "SELECT MAX(ts) as max_ts FROM http_requests_ts WHERE zone_id = ?",
  bots:              "SELECT MAX(ts) as max_ts FROM bot_traffic_ts WHERE zone_id = ?",
  "api-shield":      "SELECT MAX(ts) as max_ts FROM api_session_ts WHERE zone_id = ?",
  ddos:              "SELECT MAX(ts) as max_ts FROM ddos_events_ts WHERE zone_id = ?",
  "gateway-dns":     "SELECT MAX(ts) as max_ts FROM gateway_dns_ts WHERE account_id = ?",
  "gateway-network": "SELECT MAX(ts) as max_ts FROM gateway_network_ts WHERE account_id = ?",
  "shadow-it":       "SELECT MAX(ts) as max_ts FROM shadow_it_usage_ts WHERE account_id = ?",
  "devices-users":   "SELECT MAX(collected_at) as max_ts FROM zt_devices WHERE account_id = ?",
  "zt-summary":      "SELECT MAX(ts) as max_ts FROM daily_active_users_ts WHERE account_id = ?",
  "access-audit":    "SELECT MAX(ts) as max_ts FROM access_logins_ts WHERE account_id = ?",
};


// =============================================================================
// Exported public API
// =============================================================================

/**
 * Dispatch report data to the appropriate type-specific store function.
 *
 * @param scopeId     - zone_id or account_id
 * @param scopeName   - human-readable name (not stored by this function directly)
 * @param reportType  - one of the 16 report type keys
 * @param collectedAt - unix epoch seconds
 * @param data        - the fetcher's return object
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
    console.warn(`[data-store] Unknown report type: ${reportType}`);
    return;
  }

  try {
    storeFn(db, scopeId, collectedAt, data);
  } catch (err) {
    console.error(`[data-store] Failed to store ${reportType} for ${scopeId}:`, (err as Error).message);
    throw err;
  }
}

/**
 * Get the most recent timestamp from the relevant time series table.
 * Used by the collector to know where to resume fetching from.
 *
 * @returns unix epoch seconds, or null if no data exists
 */
export function getLastTimestamp(scopeId: string, reportType: string): number | null {
  const db = getDb();
  if (!db) return null;

  const query = LAST_TS_QUERIES[reportType];
  if (!query) return null;

  const row = db.prepare(query).get(scopeId) as { max_ts: number | null } | undefined;
  return row?.max_ts ?? null;
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
): void {
  const db = getDb();
  if (!db) return;

  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE collection_runs
    SET finished_at = ?, status = ?, success_count = ?, error_count = ?
    WHERE run_id = ?
  `).run(now, status, successCount, errorCount, runId);
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
// Query helpers (preserved from previous version for existing consumers)
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

  return db.prepare(`
    SELECT
      cl.scope_id,
      cl.scope_name,
      cl.report_type,
      MAX(cl.collected_at) as last_collected_at,
      COALESCE(
        (SELECT COUNT(*) FROM aggregate_stats a
         WHERE a.scope_id = cl.scope_id
           AND a.report_type = cl.report_type
           AND a.collected_at = (SELECT MAX(a2.collected_at) FROM aggregate_stats a2
                                  WHERE a2.scope_id = cl.scope_id AND a2.report_type = cl.report_type)),
        0
      ) as data_point_count,
      COUNT(*) as collection_count
    FROM collection_log cl
    WHERE cl.status = 'success'
    GROUP BY cl.scope_id, cl.report_type
    ORDER BY cl.scope_name ASC, cl.report_type ASC
  `).all() as DataAvailabilityRow[];
}

/**
 * Get aggregate stats for a scope + report type, optionally filtered by time range.
 */
export function getAggregateStats(
  scopeId: string,
  reportType: string,
  from?: number,
  to?: number,
): AggregateStatRow[] {
  const db = getDb();
  if (!db) return [];

  const conditions = ["scope_id = ?", "report_type = ?"];
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

/** Table name mapping for time series queries. */
const TIME_SERIES_TABLES: Record<string, { table: string; scopeCol: string }> = {
  executive:         { table: "http_requests_ts", scopeCol: "zone_id" },
  traffic:           { table: "http_requests_ts", scopeCol: "zone_id" },
  performance:       { table: "http_requests_ts", scopeCol: "zone_id" },
  security:          { table: "firewall_events_ts", scopeCol: "zone_id" },
  bots:              { table: "bot_traffic_ts", scopeCol: "zone_id" },
  ddos:              { table: "ddos_events_ts", scopeCol: "zone_id" },
  "origin-health":   { table: "origin_health_ts", scopeCol: "zone_id" },
  dns:               { table: "dns_queries_ts", scopeCol: "zone_id" },
  ssl:               { table: "http_requests_ts", scopeCol: "zone_id" },
  "api-shield":      { table: "api_session_ts", scopeCol: "zone_id" },
  "gateway-dns":     { table: "gateway_dns_ts", scopeCol: "account_id" },
  "gateway-network": { table: "gateway_network_ts", scopeCol: "account_id" },
  "shadow-it":       { table: "shadow_it_usage_ts", scopeCol: "account_id" },
  "devices-users":   { table: "zt_devices", scopeCol: "account_id" },
  "zt-summary":      { table: "daily_active_users_ts", scopeCol: "account_id" },
  "access-audit":    { table: "access_logins_ts", scopeCol: "account_id" },
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

/**
 * Overall statistics across all collections.
 */
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
