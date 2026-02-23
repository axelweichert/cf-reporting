import { cfGraphQL } from "@/lib/use-cf-data";

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

interface Recommendation {
  severity: "info" | "warning" | "critical";
  title: string;
  description: string;
}

export interface ExecutiveData {
  traffic: TrafficSummary;
  security: SecuritySummary;
  recommendations: Recommendation[];
  statusCodeBreakdown: Array<{ name: string; value: number }>;
  topCountries: Array<{ name: string; value: number }>;
}

export async function fetchExecutiveData(
  zoneTag: string,
  since: string,
  until: string
): Promise<ExecutiveData> {
  const [trafficData, securityData, statusCodes, countries] = await Promise.all([
    fetchTrafficSummary(zoneTag, since, until),
    fetchSecuritySummary(zoneTag, since, until),
    fetchStatusCodeSummary(zoneTag, since, until),
    fetchTopCountriesSummary(zoneTag, since, until),
  ]);

  const recommendations = generateRecommendations(trafficData, securityData);

  return {
    traffic: trafficData,
    security: securityData,
    recommendations,
    statusCodeBreakdown: statusCodes,
    topCountries: countries,
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
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", source_in: ["l7ddos"] }
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
    .map(([name, count]) => ({ name, count }))
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
    name: g.dimensions.clientCountryName || "Unknown",
    value: g.count,
  }));
}

function generateRecommendations(
  traffic: TrafficSummary,
  security: SecuritySummary
): Recommendation[] {
  const recs: Recommendation[] = [];

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

  return recs;
}
