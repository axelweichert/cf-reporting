import { cfGraphQL, cfRestPaginated, splitDateRange } from "@/lib/use-cf-data";

// --- Types ---
interface DnsTimeSeriesPoint {
  date: string;
  [queryType: string]: string | number;
}

interface ResponseCodeItem {
  name: string;
  value: number;
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

interface DnsRecordHealth extends DnsRecord {
  queryCount: number;
  hasNxdomain: boolean;
  status: "active" | "unqueried" | "error";
  daysSinceModified: number | null;
}

interface StaleRecordSummary {
  totalStale: number;
  byType: Array<{ type: string; count: number }>;
  oldestUnqueried: Array<{ name: string; type: string; daysSinceModified: number }>;
}

interface TopQueriedRecord {
  name: string;
  count: number;
}

interface DnsLatency {
  avg: number;
  p50: number;
  p90: number;
  p99: number;
}

export interface DnsData {
  queryVolumeByType: DnsTimeSeriesPoint[];
  queryTypes: string[];
  responseCodeBreakdown: ResponseCodeItem[];
  dnsRecords: DnsRecordHealth[];
  topQueriedRecords: TopQueriedRecord[];
  nxdomainHotspots: TopQueriedRecord[];
  totalQueries: number;
  latency: DnsLatency;
  staleRecords: StaleRecordSummary;
}

// --- Queries ---
export async function fetchDnsData(
  zoneTag: string,
  since: string,
  until: string
): Promise<DnsData> {
  // D6 optimization: run chunked time series, batched aggregates, and REST records in parallel
  // This reduces 5 separate API calls to 3 parallel groups (chunked GraphQL + batched GraphQL + REST)
  const [queryVolume, aggregates, rawRecords] = await Promise.all([
    fetchQueryVolumeByType(zoneTag, since, until),
    fetchDnsAggregates(zoneTag, since, until),
    fetchDnsRecords(zoneTag),
  ]);

  const totalQueries = aggregates.responseCodes.reduce((sum, r) => sum + r.value, 0);

  // D3: Cross-reference records with query data for health status
  const queriedNames = new Map<string, number>();
  for (const r of aggregates.allQueriedNames) {
    queriedNames.set(r.name.toLowerCase(), r.count);
  }
  const nxdomainNames = new Set(
    aggregates.nxdomainHotspots.map((n) => n.name.toLowerCase())
  );

  const now = Date.now();
  const dnsRecords: DnsRecordHealth[] = rawRecords.map((record) => {
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

  // D4: Stale record summary
  const staleRecords = buildStaleRecordSummary(dnsRecords);

  return {
    queryVolumeByType: queryVolume.timeSeries,
    queryTypes: queryVolume.types,
    responseCodeBreakdown: aggregates.responseCodes,
    dnsRecords,
    topQueriedRecords: aggregates.topQueried,
    nxdomainHotspots: aggregates.nxdomainHotspots,
    totalQueries,
    latency: aggregates.latency,
    staleRecords,
  };
}

// --- Batched aggregates query (D6: combines 4 separate calls into 1) ---
interface DnsAggregates {
  responseCodes: ResponseCodeItem[];
  topQueried: TopQueriedRecord[];
  allQueriedNames: TopQueriedRecord[];
  nxdomainHotspots: TopQueriedRecord[];
  latency: DnsLatency;
}

async function fetchDnsAggregates(
  zoneTag: string,
  since: string,
  until: string
): Promise<DnsAggregates> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        responseCodes: dnsAnalyticsAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { responseCode }
        }
        topQueried: dnsAnalyticsAdaptiveGroups(
          limit: 20
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { queryName }
        }
        allQueried: dnsAnalyticsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { queryName }
        }
        nxdomains: dnsAnalyticsAdaptiveGroups(
          limit: 15
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            responseCode: "NXDOMAIN"
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { queryName }
        }
        latency: dnsAnalyticsAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          avg { processingTimeUs }
          quantiles {
            processingTimeUsP50
            processingTimeUsP90
            processingTimeUsP99
          }
        }
      }
    }
  }`;

  interface RCodeGroup { count: number; dimensions: { responseCode: string } }
  interface NameGroup { count: number; dimensions: { queryName: string } }
  interface LatencyGroup {
    avg: { processingTimeUs: number };
    quantiles: {
      processingTimeUsP50: number;
      processingTimeUsP90: number;
      processingTimeUsP99: number;
    };
  }

  const data = await cfGraphQL<{
    viewer: {
      zones: Array<{
        responseCodes: RCodeGroup[];
        topQueried: NameGroup[];
        allQueried: NameGroup[];
        nxdomains: NameGroup[];
        latency: LatencyGroup[];
      }>;
    };
  }>(query);

  const zone = data.viewer.zones[0];

  // Response codes
  const byCode = new Map<string, number>();
  for (const g of zone?.responseCodes || []) {
    const code = g.dimensions.responseCode || "UNKNOWN";
    byCode.set(code, (byCode.get(code) || 0) + g.count);
  }
  const responseCodes = Array.from(byCode.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  // Top queried (for display)
  const topQueried = (zone?.topQueried || []).map((g) => ({
    name: g.dimensions.queryName || "unknown",
    count: g.count,
  }));

  // All queried names (for health cross-reference)
  const allQueriedNames = (zone?.allQueried || []).map((g) => ({
    name: g.dimensions.queryName || "unknown",
    count: g.count,
  }));

  // NXDOMAIN hotspots
  const nxdomainHotspots = (zone?.nxdomains || []).map((g) => ({
    name: g.dimensions.queryName || "unknown",
    count: g.count,
  }));

  // Latency (convert microseconds to milliseconds)
  const latencyData = zone?.latency[0];
  const latency: DnsLatency = latencyData
    ? {
        avg: Math.round(latencyData.avg.processingTimeUs / 1000 * 100) / 100,
        p50: Math.round(latencyData.quantiles.processingTimeUsP50 / 1000 * 100) / 100,
        p90: Math.round(latencyData.quantiles.processingTimeUsP90 / 1000 * 100) / 100,
        p99: Math.round(latencyData.quantiles.processingTimeUsP99 / 1000 * 100) / 100,
      }
    : { avg: 0, p50: 0, p90: 0, p99: 0 };

  return { responseCodes, topQueried, allQueriedNames, nxdomainHotspots, latency };
}

// --- Time series (must stay chunked due to high cardinality) ---
async function fetchQueryVolumeChunk(
  zoneTag: string,
  since: string,
  until: string
): Promise<{ byHour: Map<string, DnsTimeSeriesPoint>; types: Set<string> }> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        dnsAnalyticsAdaptiveGroups(
          limit: 1000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          dimensions { datetimeHour queryType }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { datetimeHour: string; queryType: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ dnsAnalyticsAdaptiveGroups: Group[] }> };
  }>(query);

  const types = new Set<string>();
  const byHour = new Map<string, DnsTimeSeriesPoint>();

  for (const g of data.viewer.zones[0]?.dnsAnalyticsAdaptiveGroups || []) {
    const hour = g.dimensions.datetimeHour;
    const qType = g.dimensions.queryType || "OTHER";
    types.add(qType);
    const existing = byHour.get(hour) || { date: hour };
    existing[qType] = ((existing[qType] as number) || 0) + g.count;
    byHour.set(hour, existing);
  }

  return { byHour, types };
}

async function fetchQueryVolumeByType(
  zoneTag: string,
  since: string,
  until: string
): Promise<{ timeSeries: DnsTimeSeriesPoint[]; types: string[] }> {
  // Split into daily chunks to avoid GraphQL limit: 1000 truncation
  // (7 days x 24 hours x ~20 query types = 3360 groups, far exceeds 1000)
  const chunks = splitDateRange(since, until);
  const chunkResults = await Promise.all(
    chunks.map((c) => fetchQueryVolumeChunk(zoneTag, c.since, c.until))
  );

  // Merge all chunks
  const allTypes = new Set<string>();
  const merged = new Map<string, DnsTimeSeriesPoint>();

  for (const { byHour, types } of chunkResults) {
    for (const t of types) allTypes.add(t);
    for (const [hour, point] of byHour) {
      const existing = merged.get(hour) || { date: hour };
      for (const [key, value] of Object.entries(point)) {
        if (key === "date") continue;
        existing[key] = ((existing[key] as number) || 0) + (value as number);
      }
      merged.set(hour, existing);
    }
  }

  return {
    timeSeries: Array.from(merged.values()).sort((a, b) =>
      (a.date as string).localeCompare(b.date as string)
    ),
    types: Array.from(allTypes).sort(),
  };
}

async function fetchDnsRecords(zoneTag: string): Promise<DnsRecord[]> {
  return cfRestPaginated<DnsRecord>(`/zones/${zoneTag}/dns_records`);
}

// D4: Build stale record summary from health-annotated records
function buildStaleRecordSummary(records: DnsRecordHealth[]): StaleRecordSummary {
  const stale = records.filter((r) => r.status === "unqueried" || r.status === "error");

  // Group by type
  const byType = new Map<string, number>();
  for (const r of stale) {
    byType.set(r.type, (byType.get(r.type) || 0) + 1);
  }
  const byTypeArr = Array.from(byType.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  // Oldest unqueried records (candidates for cleanup)
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
