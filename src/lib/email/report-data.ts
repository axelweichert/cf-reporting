/**
 * Server-side report data fetcher for email delivery.
 *
 * Uses CloudflareClient directly (not the browser proxy).
 * Mirrors the query logic from src/lib/queries/ but only for the
 * report types supported by email templates.
 */

import { CloudflareClient } from "@/lib/cf-client";
import type { ExecutiveData } from "@/lib/queries/executive";
import type { TrafficData } from "@/lib/queries/traffic";
import type { PerformanceData } from "@/lib/queries/performance";
import type { DnsData } from "@/lib/queries/dns";
import { formatSourceLabel } from "@/lib/source-labels";
import { splitDateRange } from "@/lib/date-utils";
import { resolveColoCode } from "@/lib/colo-map";

// --- Helpers ---

async function gql<T>(client: CloudflareClient, query: string): Promise<T> {
  const res = await client.graphql<T>(query);
  if (res.errors?.length) throw new Error(res.errors[0].message);
  return res.data;
}

async function rest<T>(client: CloudflareClient, path: string): Promise<T> {
  const res = await client.rest<T>(path);
  if (!res.success) throw new Error(res.errors?.[0]?.message || "API request failed");
  return res.result;
}

function formatCountry(input: string): string {
  if (!input || input === "Unknown") return "Unknown";
  try {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    if (input.length === 2) {
      const name = names.of(input.toUpperCase());
      return name && name !== input ? `${name} (${input.toUpperCase()})` : input;
    }
  } catch { /* pass */ }
  return input;
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms}ms`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1_000_000_000_000) return `${(bytes / 1_000_000_000_000).toFixed(1)} TB`;
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000).toFixed(1)} KB`;
}

// --- Executive Report ---

export async function fetchExecutiveDataServer(
  token: string,
  zoneTag: string,
  since: string,
  until: string
): Promise<ExecutiveData> {
  const client = new CloudflareClient(token);

  const [traffic, security, statusCodes, countries, performance] = await Promise.all([
    fetchTrafficSummary(client, zoneTag, since, until),
    fetchSecuritySummary(client, zoneTag, since, until),
    fetchStatusCodeSummary(client, zoneTag, since, until),
    fetchTopCountries(client, zoneTag, since, until),
    fetchPerformanceSummary(client, zoneTag, since, until),
  ]);

  const recommendations = generateRecommendations(traffic, security, statusCodes, performance);
  const summary = generateExecutiveSummary(traffic, security, statusCodes, performance);

  return {
    traffic,
    security,
    performance,
    recommendations,
    statusCodeBreakdown: statusCodes,
    topCountries: countries,
    summary,
  };
}

// --- Security Summary (for security email template) ---

export interface SecurityEmailData {
  totalThreatsBlocked: number;
  challengeSolveRate: number;
  topSources: Array<{ name: string; value: number }>;
  topBlockRules: Array<{ name: string; count: number }>;
  topAttackingIPs: Array<{ ip: string; count: number }>;
  topAttackingCountries: Array<{ country: string; count: number }>;
}

export async function fetchSecurityDataServer(
  token: string,
  zoneTag: string,
  since: string,
  until: string
): Promise<SecurityEmailData> {
  const client = new CloudflareClient(token);

  const [blocked, challenges, sources, ips, countries] = await Promise.all([
    fetchBlockedSummary(client, zoneTag, since, until),
    fetchChallengeSummary(client, zoneTag, since, until),
    fetchSourceBreakdown(client, zoneTag, since, until),
    fetchTopIPs(client, zoneTag, since, until),
    fetchTopCountriesBlocked(client, zoneTag, since, until),
  ]);

  // Get top block rules (simplified – no rule name resolution in email context)
  const rules = await fetchTopRules(client, zoneTag, since, until);

  return {
    totalThreatsBlocked: blocked,
    challengeSolveRate: challenges.challenged > 0
      ? (challenges.solved / challenges.challenged) * 100
      : 0,
    topSources: sources,
    topBlockRules: rules,
    topAttackingIPs: ips,
    topAttackingCountries: countries,
  };
}

// --- Internal query functions ---

interface TrafficSummary {
  totalRequests: number;
  totalBandwidth: number;
  cacheHitRatio: number;
  cachedRequests: number;
}

async function fetchTrafficSummary(client: CloudflareClient, zoneTag: string, since: string, until: string): Promise<TrafficSummary> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { cacheStatus }
          sum { edgeResponseBytes }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { cacheStatus: string };
    sum: { edgeResponseBytes: number };
  }

  const data = await gql<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(client, query);
  let totalRequests = 0, totalBandwidth = 0, cachedRequests = 0;
  for (const g of data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []) {
    totalRequests += g.count;
    totalBandwidth += g.sum.edgeResponseBytes;
    const status = g.dimensions.cacheStatus.toLowerCase();
    if (status === "hit" || status === "stale" || status === "revalidated") cachedRequests += g.count;
  }

  return { totalRequests, totalBandwidth, cachedRequests, cacheHitRatio: totalRequests > 0 ? (cachedRequests / totalRequests) * 100 : 0 };
}

interface SecuritySummary {
  totalThreatsBlocked: number;
  ddosMitigated: number;
  topThreatVectors: Array<{ name: string; count: number }>;
}

async function fetchSecuritySummary(client: CloudflareClient, zoneTag: string, since: string, until: string): Promise<SecuritySummary> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        threats: firewallEventsAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", action: "block" }
        ) { count dimensions { source } }
        ddos: firewallEventsAdaptiveGroups(
          limit: 10
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", source_in: ["l7ddos"], action: "block" }
        ) { count }
      }
    }
  }`;

  interface Group { count: number; dimensions: { source: string } }
  interface DdosGroup { count: number }

  const data = await gql<{ viewer: { zones: Array<{ threats: Group[]; ddos: DdosGroup[] }> } }>(client, query);
  const zone = data.viewer.zones[0];
  const totalThreatsBlocked = (zone?.threats || []).reduce((sum, g) => sum + g.count, 0);
  const ddosMitigated = (zone?.ddos || []).reduce((sum, g) => sum + g.count, 0);

  const vectorMap = new Map<string, number>();
  for (const g of zone?.threats || []) {
    const src = g.dimensions.source || "unknown";
    vectorMap.set(src, (vectorMap.get(src) || 0) + g.count);
  }

  return {
    totalThreatsBlocked,
    ddosMitigated,
    topThreatVectors: Array.from(vectorMap.entries())
      .map(([name, count]) => ({ name: formatSourceLabel(name), count }))
      .sort((a, b) => b.count - a.count).slice(0, 5),
  };
}

async function fetchStatusCodeSummary(client: CloudflareClient, zoneTag: string, since: string, until: string): Promise<Array<{ name: string; value: number }>> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) { count dimensions { edgeResponseStatus } }
      }
    }
  }`;

  interface Group { count: number; dimensions: { edgeResponseStatus: number } }
  const data = await gql<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(client, query);
  const classes = new Map<string, number>();
  for (const g of data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []) {
    const cls = `${Math.floor(g.dimensions.edgeResponseStatus / 100)}xx`;
    classes.set(cls, (classes.get(cls) || 0) + g.count);
  }
  return Array.from(classes.entries()).map(([name, value]) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchTopCountries(client: CloudflareClient, zoneTag: string, since: string, until: string): Promise<Array<{ name: string; value: number }>> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 10
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) { count dimensions { clientCountryName } }
      }
    }
  }`;

  interface Group { count: number; dimensions: { clientCountryName: string } }
  const data = await gql<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(client, query);
  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    name: formatCountry(g.dimensions.clientCountryName),
    value: g.count,
  }));
}

interface PerformanceSummary {
  ttfb: { avg: number; p50: number; p95: number; p99: number };
  originResponseTime: { avg: number; p50: number; p95: number; p99: number };
}

async function fetchPerformanceSummary(client: CloudflareClient, zoneTag: string, since: string, until: string): Promise<PerformanceSummary> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          avg { edgeTimeToFirstByteMs originResponseDurationMs }
          quantiles {
            edgeTimeToFirstByteMsP50 edgeTimeToFirstByteMsP95 edgeTimeToFirstByteMsP99
            originResponseDurationMsP50 originResponseDurationMsP95 originResponseDurationMsP99
          }
        }
      }
    }
  }`;

  interface Group {
    avg: { edgeTimeToFirstByteMs: number; originResponseDurationMs: number };
    quantiles: Record<string, number>;
  }

  const data = await gql<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(client, query);
  const g = data.viewer.zones[0]?.httpRequestsAdaptiveGroups[0];
  if (!g) {
    const zero = { avg: 0, p50: 0, p95: 0, p99: 0 };
    return { ttfb: { ...zero }, originResponseTime: { ...zero } };
  }

  return {
    ttfb: {
      avg: Math.round(g.avg.edgeTimeToFirstByteMs),
      p50: Math.round(g.quantiles.edgeTimeToFirstByteMsP50),
      p95: Math.round(g.quantiles.edgeTimeToFirstByteMsP95),
      p99: Math.round(g.quantiles.edgeTimeToFirstByteMsP99),
    },
    originResponseTime: {
      avg: Math.round(g.avg.originResponseDurationMs),
      p50: Math.round(g.quantiles.originResponseDurationMsP50),
      p95: Math.round(g.quantiles.originResponseDurationMsP95),
      p99: Math.round(g.quantiles.originResponseDurationMsP99),
    },
  };
}

// --- Security email-specific queries ---

async function fetchBlockedSummary(client: CloudflareClient, zoneTag: string, since: string, until: string): Promise<number> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", action: "block" }
        ) { count }
      }
    }
  }`;

  interface Group { count: number }
  const data = await gql<{ viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> } }>(client, query);
  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).reduce((s, g) => s + g.count, 0);
}

async function fetchChallengeSummary(client: CloudflareClient, zoneTag: string, since: string, until: string): Promise<{ challenged: number; solved: number }> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        challenged: firewallEventsAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", action_in: ["challenge", "managed_challenge", "js_challenge"] }
        ) { count }
        solved: firewallEventsAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", action_in: ["managed_challenge_bypassed", "managed_challenge_interactive_solved", "managed_challenge_non_interactive_solved"] }
        ) { count }
      }
    }
  }`;

  interface Group { count: number }
  const data = await gql<{ viewer: { zones: Array<{ challenged: Group[]; solved: Group[] }> } }>(client, query);
  const zone = data.viewer.zones[0];
  return {
    challenged: (zone?.challenged || []).reduce((s, g) => s + g.count, 0),
    solved: (zone?.solved || []).reduce((s, g) => s + g.count, 0),
  };
}

async function fetchSourceBreakdown(client: CloudflareClient, zoneTag: string, since: string, until: string): Promise<Array<{ name: string; value: number }>> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 20
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) { count dimensions { source } }
      }
    }
  }`;

  interface Group { count: number; dimensions: { source: string } }
  const data = await gql<{ viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> } }>(client, query);
  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).map((g) => ({
    name: formatSourceLabel(g.dimensions.source || "unknown"),
    value: g.count,
  }));
}

async function fetchTopIPs(client: CloudflareClient, zoneTag: string, since: string, until: string): Promise<Array<{ ip: string; count: number }>> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 10
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", action: "block" }
          orderBy: [count_DESC]
        ) { count dimensions { clientIP } }
      }
    }
  }`;

  interface Group { count: number; dimensions: { clientIP: string } }
  const data = await gql<{ viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> } }>(client, query);
  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).map((g) => ({
    ip: g.dimensions.clientIP,
    count: g.count,
  }));
}

async function fetchTopCountriesBlocked(client: CloudflareClient, zoneTag: string, since: string, until: string): Promise<Array<{ country: string; count: number }>> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 10
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", action: "block" }
          orderBy: [count_DESC]
        ) { count dimensions { clientCountryName } }
      }
    }
  }`;

  interface Group { count: number; dimensions: { clientCountryName: string } }
  const data = await gql<{ viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> } }>(client, query);
  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).map((g) => ({
    country: formatCountry(g.dimensions.clientCountryName),
    count: g.count,
  }));
}

async function fetchTopRules(client: CloudflareClient, zoneTag: string, since: string, until: string): Promise<Array<{ name: string; count: number }>> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 10
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", action: "block" }
          orderBy: [count_DESC]
        ) { count dimensions { ruleId } }
      }
    }
  }`;

  interface Group { count: number; dimensions: { ruleId: string } }
  const data = await gql<{ viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> } }>(client, query);
  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).map((g) => ({
    name: g.dimensions.ruleId,
    count: g.count,
  }));
}

// --- Recommendations generator (shared with executive.ts) ---

function generateRecommendations(
  traffic: TrafficSummary,
  security: SecuritySummary,
  statusCodes: Array<{ name: string; value: number }>,
  performance: PerformanceSummary,
) {
  const recs: Array<{ severity: "info" | "warning" | "critical"; title: string; description: string }> = [];

  if (traffic.cacheHitRatio < 50) {
    recs.push({ severity: "warning", title: "Low Cache Hit Ratio", description: `Cache hit ratio is ${traffic.cacheHitRatio.toFixed(1)}%. Consider adding page rules or cache rules to improve cacheability.` });
  } else if (traffic.cacheHitRatio >= 80) {
    recs.push({ severity: "info", title: "Excellent Cache Performance", description: `Cache hit ratio of ${traffic.cacheHitRatio.toFixed(1)}% is excellent.` });
  }

  if (security.ddosMitigated > 0) {
    recs.push({ severity: "critical", title: "DDoS Activity Detected", description: `${security.ddosMitigated.toLocaleString()} DDoS events mitigated. Ensure DDoS protection rules are up to date.` });
  }
  if (security.totalThreatsBlocked === 0) {
    recs.push({ severity: "warning", title: "No WAF Blocks Detected", description: "No firewall blocks recorded. Verify WAF rules are properly configured." });
  }
  if (security.totalThreatsBlocked > 10000) {
    recs.push({ severity: "info", title: "Active Threat Mitigation", description: `${security.totalThreatsBlocked.toLocaleString()} threats blocked. WAF is actively protecting your applications.` });
  }

  const total = statusCodes.reduce((s, c) => s + c.value, 0);
  if (total > 0) {
    const rate5xx = ((statusCodes.find((c) => c.name === "5xx")?.value || 0) / total) * 100;
    const rate4xx = ((statusCodes.find((c) => c.name === "4xx")?.value || 0) / total) * 100;
    if (rate5xx > 1) recs.push({ severity: "critical", title: "Elevated Server Error Rate", description: `${rate5xx.toFixed(1)}% of responses are 5xx. Investigate origin health.` });
    if (rate4xx > 10) recs.push({ severity: "warning", title: "High Client Error Rate", description: `${rate4xx.toFixed(1)}% of responses are 4xx. Check for broken links or restrictive rules.` });
  }

  if (performance.originResponseTime.p95 > 2000) {
    recs.push({ severity: "critical", title: "Slow Origin Response Time", description: `Origin P95 is ${performance.originResponseTime.p95.toLocaleString()}ms. Consider backend optimization.` });
  } else if (performance.originResponseTime.p95 > 1000) {
    recs.push({ severity: "warning", title: "Moderate Origin Latency", description: `Origin P95 is ${performance.originResponseTime.p95.toLocaleString()}ms. Monitor for degradation.` });
  }

  return recs;
}

function generateExecutiveSummary(
  traffic: TrafficSummary,
  security: SecuritySummary,
  statusCodes: Array<{ name: string; value: number }>,
  performance: PerformanceSummary,
): string {
  const parts: string[] = [];
  parts.push(`During this period, the zone served ${fmtNum(traffic.totalRequests)} requests totaling ${fmtBytes(traffic.totalBandwidth)} of bandwidth.`);

  if (traffic.cacheHitRatio >= 80) {
    parts.push(`Cache performance is strong with a ${traffic.cacheHitRatio.toFixed(1)}% hit ratio.`);
  } else if (traffic.cacheHitRatio >= 50) {
    parts.push(`The cache hit ratio of ${traffic.cacheHitRatio.toFixed(1)}% indicates room for improvement.`);
  } else {
    parts.push(`The cache hit ratio of ${traffic.cacheHitRatio.toFixed(1)}% is low – improving caching strategy should be a priority.`);
  }

  const total = statusCodes.reduce((s, c) => s + c.value, 0);
  if (total > 0) {
    const rate5xx = ((statusCodes.find((c) => c.name === "5xx")?.value || 0) / total) * 100;
    if (rate5xx > 1) parts.push(`Server error rate is elevated at ${rate5xx.toFixed(1)}%.`);
    else parts.push(`Error rates are healthy – 5xx at ${rate5xx.toFixed(2)}%.`);
  }

  parts.push(`Performance: median TTFB ${fmtMs(performance.ttfb.p50)} (P95: ${fmtMs(performance.ttfb.p95)}), origin response ${fmtMs(performance.originResponseTime.p50)} (P95: ${fmtMs(performance.originResponseTime.p95)}).`);

  if (security.totalThreatsBlocked > 0) {
    parts.push(`Security: ${fmtNum(security.totalThreatsBlocked)} threats blocked.`);
    if (security.ddosMitigated > 0) parts.push(`Including ${fmtNum(security.ddosMitigated)} L7 DDoS mitigations.`);
  }

  return parts.join(" ");
}

// =============================================
// Server-side fetchers for data collection
// =============================================

// --- Traffic ---

export async function fetchTrafficDataServer(
  token: string,
  zoneTag: string,
  since: string,
  until: string,
): Promise<TrafficData> {
  const client = new CloudflareClient(token);

  const [timeSeries, statusCodes, topPaths, topCountries, cacheData, contentTypes, errorTrend, bandwidthByCache] = await Promise.all([
    fetchTimeSeriesServer(client, zoneTag, since, until),
    fetchStatusCodesServer(client, zoneTag, since, until),
    fetchTopPathsServer(client, zoneTag, since, until),
    fetchTopCountriesServer(client, zoneTag, since, until),
    fetchCacheStatsServer(client, zoneTag, since, until),
    fetchContentTypesServer(client, zoneTag, since, until),
    fetchErrorTrendServer(client, zoneTag, since, until),
    fetchBandwidthByCacheServer(client, zoneTag, since, until),
  ]);

  const totalRequests = timeSeries.reduce((sum, p) => sum + p.requests, 0);
  const totalBandwidth = timeSeries.reduce((sum, p) => sum + p.bandwidth, 0);

  return {
    timeSeries,
    statusCodes,
    topPaths,
    topCountries,
    cache: cacheData,
    totalRequests,
    totalBandwidth,
    contentTypes,
    errorTrend,
    bandwidthByCache,
  };
}

interface TSPoint { date: string; requests: number; bandwidth: number; cachedRequests: number }

async function fetchTimeSeriesChunkServer(client: CloudflareClient, zoneTag: string, since: string, until: string): Promise<Map<string, TSPoint>> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 1000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          dimensions { datetimeHour cacheStatus }
          sum { edgeResponseBytes }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { datetimeHour: string; cacheStatus: string };
    sum: { edgeResponseBytes: number };
  }

  const data = await gql<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(client, query);
  const byHour = new Map<string, TSPoint>();
  for (const g of data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []) {
    const hour = g.dimensions.datetimeHour;
    const existing = byHour.get(hour) || { date: hour, requests: 0, bandwidth: 0, cachedRequests: 0 };
    existing.requests += g.count;
    existing.bandwidth += g.sum.edgeResponseBytes;
    const cs = g.dimensions.cacheStatus.toLowerCase();
    if (cs === "hit" || cs === "stale" || cs === "revalidated") existing.cachedRequests += g.count;
    byHour.set(hour, existing);
  }
  return byHour;
}

async function fetchTimeSeriesServer(client: CloudflareClient, zoneTag: string, since: string, until: string): Promise<TSPoint[]> {
  const chunks = splitDateRange(since, until);
  const chunkResults = await Promise.all(chunks.map((c) => fetchTimeSeriesChunkServer(client, zoneTag, c.since, c.until)));
  const merged = new Map<string, TSPoint>();
  for (const chunk of chunkResults) {
    for (const [hour, point] of chunk) {
      const existing = merged.get(hour);
      if (existing) {
        existing.requests += point.requests;
        existing.bandwidth += point.bandwidth;
        existing.cachedRequests += point.cachedRequests;
      } else {
        merged.set(hour, { ...point });
      }
    }
  }
  return Array.from(merged.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchStatusCodesServer(client: CloudflareClient, zoneTag: string, since: string, until: string) {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) { count dimensions { edgeResponseStatus } }
      }
    }
  }`;
  interface Group { count: number; dimensions: { edgeResponseStatus: number } }
  const data = await gql<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(client, query);
  const classes = new Map<string, number>();
  for (const g of data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []) {
    const cls = `${Math.floor(g.dimensions.edgeResponseStatus / 100)}xx`;
    classes.set(cls, (classes.get(cls) || 0) + g.count);
  }
  return Array.from(classes.entries()).map(([name, value]) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchTopPathsServer(client: CloudflareClient, zoneTag: string, since: string, until: string) {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 15
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) { count dimensions { clientRequestPath } }
      }
    }
  }`;
  interface Group { count: number; dimensions: { clientRequestPath: string } }
  const data = await gql<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(client, query);
  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    name: g.dimensions.clientRequestPath || "/",
    value: g.count,
  }));
}

async function fetchTopCountriesServer(client: CloudflareClient, zoneTag: string, since: string, until: string) {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 20
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) { count dimensions { clientCountryName } }
      }
    }
  }`;
  interface Group { count: number; dimensions: { clientCountryName: string } }
  const data = await gql<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(client, query);
  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    name: formatCountry(g.dimensions.clientCountryName),
    value: g.count,
  }));
}

async function fetchCacheStatsServer(client: CloudflareClient, zoneTag: string, since: string, until: string) {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) { count dimensions { cacheStatus } }
      }
    }
  }`;
  interface Group { count: number; dimensions: { cacheStatus: string } }
  const data = await gql<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(client, query);
  let hit = 0, total = 0;
  for (const g of data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []) {
    total += g.count;
    const status = g.dimensions.cacheStatus.toLowerCase();
    if (status === "hit" || status === "stale" || status === "revalidated") hit += g.count;
  }
  return { hit, miss: total - hit, total, ratio: total > 0 ? (hit / total) * 100 : 0 };
}

async function fetchContentTypesServer(client: CloudflareClient, zoneTag: string, since: string, until: string) {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 15
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) { count dimensions { edgeResponseContentTypeName } }
      }
    }
  }`;
  interface Group { count: number; dimensions: { edgeResponseContentTypeName: string } }
  const data = await gql<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(client, query);
  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    name: g.dimensions.edgeResponseContentTypeName || "unknown",
    value: g.count,
  }));
}

async function fetchErrorTrendServer(client: CloudflareClient, zoneTag: string, since: string, until: string) {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", edgeResponseStatus_geq: 400 }
          orderBy: [datetimeHour_ASC]
        ) { count dimensions { datetimeHour edgeResponseStatus } }
      }
    }
  }`;
  interface Group { count: number; dimensions: { datetimeHour: string; edgeResponseStatus: number } }
  const data = await gql<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(client, query);
  const byHour = new Map<string, { date: string; "4xx": number; "5xx": number }>();
  for (const g of data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []) {
    const hour = g.dimensions.datetimeHour;
    const existing = byHour.get(hour) || { date: hour, "4xx": 0, "5xx": 0 };
    const cls = Math.floor(g.dimensions.edgeResponseStatus / 100);
    if (cls === 4) existing["4xx"] += g.count;
    else if (cls === 5) existing["5xx"] += g.count;
    byHour.set(hour, existing);
  }
  return Array.from(byHour.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchBandwidthByCacheServer(client: CloudflareClient, zoneTag: string, since: string, until: string) {
  const CACHED_STATUSES = new Set(["hit", "stale", "revalidated"]);
  const chunks = splitDateRange(since, until);
  const chunkResults = await Promise.all(
    chunks.map(async (c) => {
      const query = `{
        viewer {
          zones(filter: { zoneTag: "${zoneTag}" }) {
            httpRequestsAdaptiveGroups(
              limit: 1000
              filter: { datetime_geq: "${c.since}", datetime_lt: "${c.until}" }
              orderBy: [datetimeHour_ASC]
            ) { dimensions { datetimeHour cacheStatus } sum { edgeResponseBytes } }
          }
        }
      }`;
      interface Group { dimensions: { datetimeHour: string; cacheStatus: string }; sum: { edgeResponseBytes: number } }
      const data = await gql<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(client, query);
      return data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [];
    })
  );
  const byHour = new Map<string, { date: string; cached: number; uncached: number }>();
  for (const groups of chunkResults) {
    for (const g of groups) {
      const hour = g.dimensions.datetimeHour;
      const existing = byHour.get(hour) || { date: hour, cached: 0, uncached: 0 };
      if (CACHED_STATUSES.has(g.dimensions.cacheStatus.toLowerCase())) {
        existing.cached += g.sum.edgeResponseBytes;
      } else {
        existing.uncached += g.sum.edgeResponseBytes;
      }
      byHour.set(hour, existing);
    }
  }
  return Array.from(byHour.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// --- Performance ---

export async function fetchPerformanceDataServer(
  token: string,
  zoneTag: string,
  since: string,
  until: string,
): Promise<PerformanceData> {
  const client = new CloudflareClient(token);

  const [overview, byContentType, byCountry, byProtocol, byColo] = await Promise.all([
    fetchOverviewServer(client, zoneTag, since, until),
    fetchByContentTypeServer(client, zoneTag, since, until),
    fetchByCountryServer(client, zoneTag, since, until),
    fetchByProtocolServer(client, zoneTag, since, until),
    fetchByColoServer(client, zoneTag, since, until),
  ]);

  return {
    timeSeries: overview.timeSeries,
    contentTypePerf: byContentType,
    countryPerf: byCountry,
    protocolDistribution: byProtocol,
    coloPerf: byColo,
    stats: overview.stats,
  };
}

async function fetchOverviewServer(client: CloudflareClient, zoneTag: string, since: string, until: string) {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        total: httpRequestsAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          avg { edgeTimeToFirstByteMs originResponseDurationMs }
          quantiles { edgeTimeToFirstByteMsP95 originResponseDurationMsP95 }
          sum { edgeResponseBytes }
        }
        timeSeries: httpRequestsAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          avg { edgeTimeToFirstByteMs originResponseDurationMs }
          dimensions { datetimeHour }
        }
      }
    }
  }`;

  interface TotalGroup {
    count: number;
    avg: { edgeTimeToFirstByteMs: number; originResponseDurationMs: number };
    quantiles: { edgeTimeToFirstByteMsP95: number; originResponseDurationMsP95: number };
    sum: { edgeResponseBytes: number };
  }
  interface TimeGroup {
    count: number;
    avg: { edgeTimeToFirstByteMs: number; originResponseDurationMs: number };
    dimensions: { datetimeHour: string };
  }

  const data = await gql<{ viewer: { zones: Array<{ total: TotalGroup[]; timeSeries: TimeGroup[] }> } }>(client, query);
  const zone = data.viewer.zones[0];
  const t = zone?.total[0];

  const timeSeries = (zone?.timeSeries || []).map((g) => ({
    date: g.dimensions.datetimeHour,
    avgTtfb: Math.round(g.avg.edgeTimeToFirstByteMs || 0),
    avgOriginTime: Math.round(g.avg.originResponseDurationMs || 0),
    requests: g.count,
  }));

  return {
    timeSeries,
    stats: {
      totalRequests: t?.count || 0,
      avgTtfb: Math.round(t?.avg.edgeTimeToFirstByteMs || 0),
      p95Ttfb: Math.round(t?.quantiles.edgeTimeToFirstByteMsP95 || 0),
      avgOriginTime: Math.round(t?.avg.originResponseDurationMs || 0),
      p95OriginTime: Math.round(t?.quantiles.originResponseDurationMsP95 || 0),
      totalBytes: t?.sum.edgeResponseBytes || 0,
    },
  };
}

async function fetchByContentTypeServer(client: CloudflareClient, zoneTag: string, since: string, until: string) {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 20
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          avg { edgeTimeToFirstByteMs originResponseDurationMs }
          sum { edgeResponseBytes }
          dimensions { edgeResponseContentTypeName }
        }
      }
    }
  }`;
  interface Group {
    count: number;
    avg: { edgeTimeToFirstByteMs: number; originResponseDurationMs: number };
    sum: { edgeResponseBytes: number };
    dimensions: { edgeResponseContentTypeName: string };
  }
  const data = await gql<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(client, query);
  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [])
    .filter((g) => g.dimensions.edgeResponseContentTypeName)
    .map((g) => ({
      contentType: g.dimensions.edgeResponseContentTypeName || "Unknown",
      requests: g.count,
      avgTtfb: Math.round(g.avg.edgeTimeToFirstByteMs || 0),
      avgOriginTime: Math.round(g.avg.originResponseDurationMs || 0),
      avgResponseBytes: g.count > 0 ? Math.round(g.sum.edgeResponseBytes / g.count) : 0,
    }))
    .slice(0, 15);
}

async function fetchByCountryServer(client: CloudflareClient, zoneTag: string, since: string, until: string) {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 15
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          avg { edgeTimeToFirstByteMs originResponseDurationMs }
          dimensions { clientCountryName }
        }
      }
    }
  }`;
  interface Group {
    count: number;
    avg: { edgeTimeToFirstByteMs: number; originResponseDurationMs: number };
    dimensions: { clientCountryName: string };
  }
  const data = await gql<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(client, query);
  const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [])
    .filter((g) => g.dimensions.clientCountryName)
    .map((g) => {
      const code = g.dimensions.clientCountryName;
      let name = code;
      try { const resolved = countryNames.of(code); if (resolved && resolved !== code) name = resolved; } catch { /* ignore */ }
      return {
        country: `${name} (${code})`,
        requests: g.count,
        avgTtfb: Math.round(g.avg.edgeTimeToFirstByteMs || 0),
        avgOriginTime: Math.round(g.avg.originResponseDurationMs || 0),
      };
    })
    .slice(0, 10);
}

async function fetchByProtocolServer(client: CloudflareClient, zoneTag: string, since: string, until: string) {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 10
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) { count dimensions { clientRequestHTTPProtocol } }
      }
    }
  }`;
  interface Group { count: number; dimensions: { clientRequestHTTPProtocol: string } }
  const data = await gql<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(client, query);
  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    protocol: g.dimensions.clientRequestHTTPProtocol || "Unknown",
    requests: g.count,
  }));
}

async function fetchByColoServer(client: CloudflareClient, zoneTag: string, since: string, until: string) {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 15
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          avg { edgeTimeToFirstByteMs }
          dimensions { coloCode }
        }
      }
    }
  }`;
  interface Group { count: number; avg: { edgeTimeToFirstByteMs: number }; dimensions: { coloCode: string } }
  const data = await gql<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(client, query);
  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [])
    .filter((g) => g.dimensions.coloCode)
    .map((g) => {
      const code = g.dimensions.coloCode;
      const info = resolveColoCode(code);
      return {
        colo: `${info.city} (${code})`,
        city: info.city,
        country: info.country,
        requests: g.count,
        avgTtfb: Math.round(g.avg.edgeTimeToFirstByteMs || 0),
      };
    })
    .slice(0, 15);
}

// --- DNS ---

export async function fetchDnsDataServer(
  token: string,
  zoneTag: string,
  since: string,
  until: string,
): Promise<DnsData> {
  const client = new CloudflareClient(token);

  const [queryVolume, aggregates, rawRecords] = await Promise.all([
    fetchQueryVolumeByTypeServer(client, zoneTag, since, until),
    fetchDnsAggregatesServer(client, zoneTag, since, until),
    fetchDnsRecordsServer(client, zoneTag),
  ]);

  const totalQueries = aggregates.responseCodes.reduce((sum, r) => sum + r.value, 0);

  // Cross-reference records with query data for health status
  const queriedNames = new Map<string, number>();
  for (const r of aggregates.allQueriedNames) queriedNames.set(r.name.toLowerCase(), r.count);
  const nxdomainNames = new Set(aggregates.nxdomainHotspots.map((n) => n.name.toLowerCase()));

  const now = Date.now();
  const dnsRecords = rawRecords.map((record) => {
    const recordName = record.name.toLowerCase();
    const queryCount = queriedNames.get(recordName) || 0;
    const hasNxdomain = nxdomainNames.has(recordName);
    let status: "active" | "unqueried" | "error" = "unqueried";
    if (hasNxdomain) status = "error";
    else if (queryCount > 0) status = "active";
    const daysSinceModified = record.modified_on
      ? Math.floor((now - new Date(record.modified_on).getTime()) / (1000 * 60 * 60 * 24))
      : null;
    return { ...record, queryCount, hasNxdomain, status, daysSinceModified };
  });

  // Stale record summary
  const stale = dnsRecords.filter((r) => r.status === "unqueried" || r.status === "error");
  const byType = new Map<string, number>();
  for (const r of stale) byType.set(r.type, (byType.get(r.type) || 0) + 1);
  const byTypeArr = Array.from(byType.entries()).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
  const oldestUnqueried = stale
    .filter((r) => r.status === "unqueried" && r.daysSinceModified !== null)
    .sort((a, b) => (b.daysSinceModified || 0) - (a.daysSinceModified || 0))
    .slice(0, 10)
    .map((r) => ({ name: r.name, type: r.type, daysSinceModified: r.daysSinceModified || 0 }));

  return {
    queryVolumeByType: queryVolume.timeSeries as DnsData["queryVolumeByType"],
    queryTypes: queryVolume.types,
    responseCodeBreakdown: aggregates.responseCodes,
    dnsRecords,
    topQueriedRecords: aggregates.topQueried,
    nxdomainHotspots: aggregates.nxdomainHotspots,
    totalQueries,
    latency: aggregates.latency,
    staleRecords: { totalStale: stale.length, byType: byTypeArr, oldestUnqueried },
  };
}

async function fetchQueryVolumeByTypeServer(
  client: CloudflareClient,
  zoneTag: string,
  since: string,
  until: string,
): Promise<{ timeSeries: Array<Record<string, string | number>>; types: string[] }> {
  // Use daily granularity for collection (7d period)
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        dnsAnalyticsAdaptiveGroups(
          limit: 1000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [date_ASC]
        ) { count dimensions { date queryType } }
      }
    }
  }`;
  interface Group { count: number; dimensions: { date: string; queryType: string } }
  const data = await gql<{ viewer: { zones: Array<{ dnsAnalyticsAdaptiveGroups: Group[] }> } }>(client, query);
  const types = new Set<string>();
  const byDate = new Map<string, Record<string, string | number>>();
  for (const g of data.viewer.zones[0]?.dnsAnalyticsAdaptiveGroups || []) {
    const day = g.dimensions.date;
    const qType = g.dimensions.queryType || "OTHER";
    types.add(qType);
    const existing = byDate.get(day) || { date: day };
    existing[qType] = ((existing[qType] as number) || 0) + g.count;
    byDate.set(day, existing);
  }
  return {
    timeSeries: Array.from(byDate.values()).sort((a, b) => (a.date as string).localeCompare(b.date as string)),
    types: Array.from(types).sort(),
  };
}

async function fetchDnsAggregatesServer(client: CloudflareClient, zoneTag: string, since: string, until: string) {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        responseCodes: dnsAnalyticsAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) { count dimensions { responseCode } }
        topQueried: dnsAnalyticsAdaptiveGroups(
          limit: 20
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) { count dimensions { queryName } }
        allQueried: dnsAnalyticsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) { count dimensions { queryName } }
        nxdomains: dnsAnalyticsAdaptiveGroups(
          limit: 15
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", responseCode: "NXDOMAIN" }
          orderBy: [count_DESC]
        ) { count dimensions { queryName } }
        latency: dnsAnalyticsAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          avg { processingTimeUs }
          quantiles { processingTimeUsP50 processingTimeUsP90 processingTimeUsP99 }
        }
      }
    }
  }`;

  interface RCodeGroup { count: number; dimensions: { responseCode: string } }
  interface NameGroup { count: number; dimensions: { queryName: string } }
  interface LatencyGroup { avg: { processingTimeUs: number }; quantiles: { processingTimeUsP50: number; processingTimeUsP90: number; processingTimeUsP99: number } }

  const data = await gql<{ viewer: { zones: Array<{
    responseCodes: RCodeGroup[];
    topQueried: NameGroup[];
    allQueried: NameGroup[];
    nxdomains: NameGroup[];
    latency: LatencyGroup[];
  }> } }>(client, query);

  const zone = data.viewer.zones[0];

  const byCode = new Map<string, number>();
  for (const g of zone?.responseCodes || []) {
    const code = g.dimensions.responseCode || "UNKNOWN";
    byCode.set(code, (byCode.get(code) || 0) + g.count);
  }
  const responseCodes = Array.from(byCode.entries()).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  const topQueried = (zone?.topQueried || []).map((g) => ({ name: g.dimensions.queryName || "unknown", count: g.count }));
  const allQueriedNames = (zone?.allQueried || []).map((g) => ({ name: g.dimensions.queryName || "unknown", count: g.count }));
  const nxdomainHotspots = (zone?.nxdomains || []).map((g) => ({ name: g.dimensions.queryName || "unknown", count: g.count }));

  const latencyData = zone?.latency[0];
  const latency = latencyData
    ? {
        avg: Math.round(latencyData.avg.processingTimeUs / 1000 * 100) / 100,
        p50: Math.round(latencyData.quantiles.processingTimeUsP50 / 1000 * 100) / 100,
        p90: Math.round(latencyData.quantiles.processingTimeUsP90 / 1000 * 100) / 100,
        p99: Math.round(latencyData.quantiles.processingTimeUsP99 / 1000 * 100) / 100,
      }
    : { avg: 0, p50: 0, p90: 0, p99: 0 };

  return { responseCodes, topQueried, allQueriedNames, nxdomainHotspots, latency };
}

interface DnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied: boolean;
  created_on?: string;
  modified_on?: string;
}

async function fetchDnsRecordsServer(client: CloudflareClient, zoneTag: string): Promise<DnsRecord[]> {
  return client.restPaginated<DnsRecord>(`/zones/${zoneTag}/dns_records`);
}
