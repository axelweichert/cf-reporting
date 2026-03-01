import { cfGraphQL, formatCountry } from "@/lib/use-cf-data";
import { formatSourceLabel } from "@/lib/source-labels";

// --- Types ---
interface TrafficSummary {
  totalRequests: number;
  totalBandwidth: number;
  cacheHitRatio: number;
  cachedRequests: number;
}

interface SecuritySummary {
  totalThreatsBlocked: number;
  ddosMitigated: number;
  topThreatVectors: Array<{ name: string; count: number }>;
}

interface PerformanceSummary {
  ttfb: { avg: number; p50: number; p95: number; p99: number };
  originResponseTime: { avg: number; p50: number; p95: number; p99: number };
}

interface Recommendation {
  severity: "info" | "warning" | "critical";
  title: string;
  description: string;
}

export interface ExecutiveData {
  traffic: TrafficSummary;
  security: SecuritySummary;
  performance: PerformanceSummary;
  recommendations: Recommendation[];
  statusCodeBreakdown: Array<{ name: string; value: number }>;
  topCountries: Array<{ name: string; value: number }>;
  summary: string;
}

export async function fetchExecutiveData(
  zoneTag: string,
  since: string,
  until: string
): Promise<ExecutiveData> {
  const [trafficData, securityData, statusCodes, countries, performance] = await Promise.all([
    fetchTrafficSummary(zoneTag, since, until),
    fetchSecuritySummary(zoneTag, since, until),
    fetchStatusCodeSummary(zoneTag, since, until),
    fetchTopCountriesSummary(zoneTag, since, until),
    fetchPerformanceSummary(zoneTag, since, until),
  ]);

  const recommendations = generateRecommendations(trafficData, securityData, statusCodes, performance);
  const summary = generateExecutiveSummary(trafficData, securityData, statusCodes, performance);

  return {
    traffic: trafficData,
    security: securityData,
    performance,
    recommendations,
    statusCodeBreakdown: statusCodes,
    topCountries: countries,
    summary,
  };
}

async function fetchTrafficSummary(zoneTag: string, since: string, until: string): Promise<TrafficSummary> {
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

  const data = await cfGraphQL<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(query);

  let totalRequests = 0;
  let totalBandwidth = 0;
  let cachedRequests = 0;

  for (const g of data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []) {
    totalRequests += g.count;
    totalBandwidth += g.sum.edgeResponseBytes;
    const status = g.dimensions.cacheStatus.toLowerCase();
    if (status === "hit" || status === "stale" || status === "revalidated") {
      cachedRequests += g.count;
    }
  }

  return {
    totalRequests,
    totalBandwidth,
    cachedRequests,
    cacheHitRatio: totalRequests > 0 ? (cachedRequests / totalRequests) * 100 : 0,
  };
}

async function fetchSecuritySummary(zoneTag: string, since: string, until: string): Promise<SecuritySummary> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        threats: firewallEventsAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", action: "block" }
        ) {
          count
          dimensions { source }
        }
        ddos: firewallEventsAdaptiveGroups(
          limit: 10
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", source_in: ["l7ddos"], action: "block" }
        ) {
          count
        }
      }
    }
  }`;

  interface Group { count: number; dimensions: { source: string } }
  interface DdosGroup { count: number }

  const data = await cfGraphQL<{
    viewer: {
      zones: Array<{
        threats: Group[];
        ddos: DdosGroup[];
      }>;
    };
  }>(query);

  const zone = data.viewer.zones[0];
  const totalThreatsBlocked = (zone?.threats || []).reduce((sum, g) => sum + g.count, 0);
  const ddosMitigated = (zone?.ddos || []).reduce((sum, g) => sum + g.count, 0);

  const vectorMap = new Map<string, number>();
  for (const g of zone?.threats || []) {
    const src = g.dimensions.source || "unknown";
    vectorMap.set(src, (vectorMap.get(src) || 0) + g.count);
  }

  const topThreatVectors = Array.from(vectorMap.entries())
    .map(([name, count]) => ({ name: formatSourceLabel(name), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return { totalThreatsBlocked, ddosMitigated, topThreatVectors };
}

async function fetchStatusCodeSummary(
  zoneTag: string, since: string, until: string
): Promise<Array<{ name: string; value: number }>> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { edgeResponseStatus }
        }
      }
    }
  }`;

  interface Group { count: number; dimensions: { edgeResponseStatus: number } }

  const data = await cfGraphQL<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(query);

  const classes = new Map<string, number>();
  for (const g of data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []) {
    const cls = `${Math.floor(g.dimensions.edgeResponseStatus / 100)}xx`;
    classes.set(cls, (classes.get(cls) || 0) + g.count);
  }

  return Array.from(classes.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchTopCountriesSummary(
  zoneTag: string, since: string, until: string
): Promise<Array<{ name: string; value: number }>> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 10
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { clientCountryName }
        }
      }
    }
  }`;

  interface Group { count: number; dimensions: { clientCountryName: string } }

  const data = await cfGraphQL<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    name: formatCountry(g.dimensions.clientCountryName),
    value: g.count,
  }));
}

async function fetchPerformanceSummary(
  zoneTag: string, since: string, until: string
): Promise<PerformanceSummary> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          avg {
            edgeTimeToFirstByteMs
            originResponseDurationMs
          }
          quantiles {
            edgeTimeToFirstByteMsP50
            edgeTimeToFirstByteMsP95
            edgeTimeToFirstByteMsP99
            originResponseDurationMsP50
            originResponseDurationMsP95
            originResponseDurationMsP99
          }
        }
      }
    }
  }`;

  interface Group {
    avg: { edgeTimeToFirstByteMs: number; originResponseDurationMs: number };
    quantiles: {
      edgeTimeToFirstByteMsP50: number;
      edgeTimeToFirstByteMsP95: number;
      edgeTimeToFirstByteMsP99: number;
      originResponseDurationMsP50: number;
      originResponseDurationMsP95: number;
      originResponseDurationMsP99: number;
    };
  }

  const data = await cfGraphQL<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(query);
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

function generateRecommendations(
  traffic: TrafficSummary,
  security: SecuritySummary,
  statusCodes: Array<{ name: string; value: number }>,
  performance: PerformanceSummary,
): Recommendation[] {
  const recs: Recommendation[] = [];

  // Cache recommendations
  if (traffic.cacheHitRatio < 50) {
    recs.push({
      severity: "warning",
      title: "Low Cache Hit Ratio",
      description: `Cache hit ratio is ${traffic.cacheHitRatio.toFixed(1)}%. Consider adding page rules or cache rules to improve cacheability and reduce origin load.`,
    });
  }
  if (traffic.cacheHitRatio >= 80) {
    recs.push({
      severity: "info",
      title: "Excellent Cache Performance",
      description: `Cache hit ratio of ${traffic.cacheHitRatio.toFixed(1)}% is excellent. Your caching strategy is working well.`,
    });
  }

  // Security recommendations
  if (security.ddosMitigated > 0) {
    recs.push({
      severity: "critical",
      title: "DDoS Activity Detected",
      description: `${security.ddosMitigated.toLocaleString()} DDoS events were mitigated in this period. Ensure DDoS protection rules are up to date.`,
    });
  }
  if (security.totalThreatsBlocked === 0) {
    recs.push({
      severity: "warning",
      title: "No WAF Blocks Detected",
      description: "No firewall blocks were recorded. Verify that WAF rules are properly configured and enabled.",
    });
  }
  if (security.totalThreatsBlocked > 10000) {
    recs.push({
      severity: "info",
      title: "Active Threat Mitigation",
      description: `${security.totalThreatsBlocked.toLocaleString()} threats blocked. Your WAF is actively protecting your applications.`,
    });
  }

  // Status code recommendations
  const totalFromCodes = statusCodes.reduce((s, c) => s + c.value, 0);
  if (totalFromCodes > 0) {
    const code4xx = statusCodes.find((c) => c.name === "4xx")?.value || 0;
    const code5xx = statusCodes.find((c) => c.name === "5xx")?.value || 0;
    const rate4xx = (code4xx / totalFromCodes) * 100;
    const rate5xx = (code5xx / totalFromCodes) * 100;

    if (rate5xx > 1) {
      recs.push({
        severity: "critical",
        title: "Elevated Server Error Rate",
        description: `${rate5xx.toFixed(1)}% of responses are 5xx server errors. Investigate origin health, capacity, and application errors.`,
      });
    }
    if (rate4xx > 10) {
      recs.push({
        severity: "warning",
        title: "High Client Error Rate",
        description: `${rate4xx.toFixed(1)}% of responses are 4xx client errors. Check for broken links, missing resources, or overly aggressive WAF rules.`,
      });
    }
  }

  // Performance recommendations
  if (performance.originResponseTime.p95 > 2000) {
    recs.push({
      severity: "critical",
      title: "Slow Origin Response Time",
      description: `Origin P95 response time is ${performance.originResponseTime.p95.toLocaleString()}ms. Consider optimizing backend queries, adding caching layers, or scaling origin infrastructure.`,
    });
  } else if (performance.originResponseTime.p95 > 1000) {
    recs.push({
      severity: "warning",
      title: "Moderate Origin Latency",
      description: `Origin P95 response time is ${performance.originResponseTime.p95.toLocaleString()}ms. Monitor for degradation and consider performance optimization.`,
    });
  }

  if (performance.ttfb.p50 > 500) {
    recs.push({
      severity: "warning",
      title: "High Time to First Byte",
      description: `Median TTFB is ${performance.ttfb.p50}ms. Consider enabling Argo Smart Routing, optimizing caching, or moving origin closer to users.`,
    });
  }

  return recs;
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

function generateExecutiveSummary(
  traffic: TrafficSummary,
  security: SecuritySummary,
  statusCodes: Array<{ name: string; value: number }>,
  performance: PerformanceSummary,
): string {
  const parts: string[] = [];

  // Traffic overview
  parts.push(
    `During this period, the zone served ${fmtNum(traffic.totalRequests)} requests totaling ${fmtBytes(traffic.totalBandwidth)} of bandwidth.`
  );

  // Cache
  if (traffic.cacheHitRatio >= 80) {
    parts.push(`Cache performance is strong with a ${traffic.cacheHitRatio.toFixed(1)}% hit ratio, meaning the majority of traffic is served from Cloudflare's edge without reaching the origin.`);
  } else if (traffic.cacheHitRatio >= 50) {
    parts.push(`The cache hit ratio of ${traffic.cacheHitRatio.toFixed(1)}% indicates room for improvement – optimizing cache rules could reduce origin load and improve response times.`);
  } else {
    parts.push(`The cache hit ratio of ${traffic.cacheHitRatio.toFixed(1)}% is low, meaning most requests reach the origin server. Improving caching strategy should be a priority.`);
  }

  // Error rates
  const totalFromCodes = statusCodes.reduce((s, c) => s + c.value, 0);
  if (totalFromCodes > 0) {
    const code5xx = statusCodes.find((c) => c.name === "5xx")?.value || 0;
    const code4xx = statusCodes.find((c) => c.name === "4xx")?.value || 0;
    const rate5xx = (code5xx / totalFromCodes) * 100;
    const rate4xx = (code4xx / totalFromCodes) * 100;
    if (rate5xx > 1) {
      parts.push(`Server error rate is elevated at ${rate5xx.toFixed(1)}% (5xx responses), indicating potential origin health issues that need investigation.`);
    } else if (rate4xx > 10) {
      parts.push(`Client errors (4xx) account for ${rate4xx.toFixed(1)}% of responses, which may indicate broken links, misconfigured redirects, or overly restrictive access rules.`);
    } else {
      parts.push(`Error rates are healthy – 5xx server errors are at ${rate5xx.toFixed(2)}% and 4xx client errors at ${rate4xx.toFixed(1)}%.`);
    }
  }

  // Performance
  parts.push(
    `Performance metrics show a median TTFB of ${fmtMs(performance.ttfb.p50)} (P95: ${fmtMs(performance.ttfb.p95)}) and median origin response time of ${fmtMs(performance.originResponseTime.p50)} (P95: ${fmtMs(performance.originResponseTime.p95)}).`
  );

  // Security
  if (security.totalThreatsBlocked > 0) {
    parts.push(`On the security front, ${fmtNum(security.totalThreatsBlocked)} threats were blocked by Cloudflare's WAF and security rules.`);
    if (security.ddosMitigated > 0) {
      parts.push(`This includes ${fmtNum(security.ddosMitigated)} L7 DDoS mitigation events.`);
    }
  } else {
    parts.push("No security threats were blocked during this period. Ensure WAF rules are enabled and properly configured.");
  }

  return parts.join(" ");
}
