/**
 * Server-side report data fetcher for email delivery.
 *
 * Uses CloudflareClient directly (not the browser proxy).
 * Mirrors the query logic from src/lib/queries/ but only for the
 * report types supported by email templates.
 */

import { CloudflareClient } from "@/lib/cf-client";
import type { ExecutiveData } from "@/lib/queries/executive";
import { formatSourceLabel } from "@/lib/source-labels";

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

  // Get top block rules (simplified — no rule name resolution in email context)
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
    parts.push(`The cache hit ratio of ${traffic.cacheHitRatio.toFixed(1)}% is low — improving caching strategy should be a priority.`);
  }

  const total = statusCodes.reduce((s, c) => s + c.value, 0);
  if (total > 0) {
    const rate5xx = ((statusCodes.find((c) => c.name === "5xx")?.value || 0) / total) * 100;
    if (rate5xx > 1) parts.push(`Server error rate is elevated at ${rate5xx.toFixed(1)}%.`);
    else parts.push(`Error rates are healthy — 5xx at ${rate5xx.toFixed(2)}%.`);
  }

  parts.push(`Performance: median TTFB ${fmtMs(performance.ttfb.p50)} (P95: ${fmtMs(performance.ttfb.p95)}), origin response ${fmtMs(performance.originResponseTime.p50)} (P95: ${fmtMs(performance.originResponseTime.p95)}).`);

  if (security.totalThreatsBlocked > 0) {
    parts.push(`Security: ${fmtNum(security.totalThreatsBlocked)} threats blocked.`);
    if (security.ddosMitigated > 0) parts.push(`Including ${fmtNum(security.ddosMitigated)} L7 DDoS mitigations.`);
  }

  return parts.join(" ");
}
