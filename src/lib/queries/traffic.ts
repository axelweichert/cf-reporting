import { cfGraphQL, formatCountry, splitDateRange } from "@/lib/use-cf-data";

// --- Types ---
interface TimeSeriesPoint {
  date: string;
  requests: number;
  bandwidth: number;
  cachedRequests: number;
}

interface StatusCodeGroup {
  name: string;
  value: number;
}

interface TopItem {
  name: string;
  value: number;
}

interface GeoItem {
  name: string;
  value: number;
}

interface CacheStats {
  hit: number;
  miss: number;
  total: number;
  ratio: number;
}

interface ContentTypeItem {
  name: string;
  value: number;
}

interface ErrorTrendPoint {
  date: string;
  "4xx": number;
  "5xx": number;
}

interface BandwidthCachePoint {
  date: string;
  cached: number;
  uncached: number;
}

export interface TrafficData {
  timeSeries: TimeSeriesPoint[];
  statusCodes: StatusCodeGroup[];
  topPaths: TopItem[];
  topCountries: GeoItem[];
  cache: CacheStats;
  totalRequests: number;
  totalBandwidth: number;
  contentTypes: ContentTypeItem[];
  errorTrend: ErrorTrendPoint[];
  bandwidthByCache: BandwidthCachePoint[];
}

// Lightweight summary for period-over-period comparison
export interface TrafficSummaryStats {
  totalRequests: number;
  totalBandwidth: number;
  cacheRatio: number;
  errorRate4xx: number;
  errorRate5xx: number;
}

export async function fetchTrafficSummaryStats(
  zoneTag: string,
  since: string,
  until: string
): Promise<TrafficSummaryStats> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        total: httpRequestsAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          sum { edgeResponseBytes }
        }
        cached: httpRequestsAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", cacheStatus: "hit" }
        ) {
          count
        }
        errors4xx: httpRequestsAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", edgeResponseStatus_geq: 400, edgeResponseStatus_lt: 500 }
        ) {
          count
        }
        errors5xx: httpRequestsAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", edgeResponseStatus_geq: 500 }
        ) {
          count
        }
      }
    }
  }`;

  interface Group { count: number; sum?: { edgeResponseBytes: number } }

  const data = await cfGraphQL<{
    viewer: {
      zones: Array<{
        total: Group[];
        cached: Group[];
        errors4xx: Group[];
        errors5xx: Group[];
      }>;
    };
  }>(query);

  const zone = data.viewer.zones[0];
  const totalRequests = (zone?.total || []).reduce((s, g) => s + g.count, 0);
  const totalBandwidth = (zone?.total || []).reduce((s, g) => s + (g.sum?.edgeResponseBytes || 0), 0);
  const cachedRequests = (zone?.cached || []).reduce((s, g) => s + g.count, 0);
  const errors4xx = (zone?.errors4xx || []).reduce((s, g) => s + g.count, 0);
  const errors5xx = (zone?.errors5xx || []).reduce((s, g) => s + g.count, 0);

  return {
    totalRequests,
    totalBandwidth,
    cacheRatio: totalRequests > 0 ? (cachedRequests / totalRequests) * 100 : 0,
    errorRate4xx: totalRequests > 0 ? (errors4xx / totalRequests) * 100 : 0,
    errorRate5xx: totalRequests > 0 ? (errors5xx / totalRequests) * 100 : 0,
  };
}

// --- Queries ---
export async function fetchTrafficData(
  zoneTag: string,
  since: string,
  until: string
): Promise<TrafficData> {
  const [timeSeries, statusCodes, topPaths, topCountries, cacheData, contentTypes, errorTrend, bandwidthByCache] = await Promise.all([
    fetchTimeSeries(zoneTag, since, until),
    fetchStatusCodes(zoneTag, since, until),
    fetchTopPaths(zoneTag, since, until),
    fetchTopCountries(zoneTag, since, until),
    fetchCacheStats(zoneTag, since, until),
    fetchContentTypes(zoneTag, since, until),
    fetchErrorTrend(zoneTag, since, until),
    fetchBandwidthByCache(zoneTag, since, until),
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

async function fetchTimeSeriesChunk(zoneTag: string, since: string, until: string): Promise<Map<string, TimeSeriesPoint>> {
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

  const data = await cfGraphQL<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(query);

  const byHour = new Map<string, TimeSeriesPoint>();
  for (const g of data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []) {
    const hour = g.dimensions.datetimeHour;
    const existing = byHour.get(hour) || { date: hour, requests: 0, bandwidth: 0, cachedRequests: 0 };
    existing.requests += g.count;
    existing.bandwidth += g.sum.edgeResponseBytes;
    if (g.dimensions.cacheStatus === "hit" || g.dimensions.cacheStatus === "stale" || g.dimensions.cacheStatus === "revalidated") {
      existing.cachedRequests += g.count;
    }
    byHour.set(hour, existing);
  }

  return byHour;
}

async function fetchTimeSeries(zoneTag: string, since: string, until: string): Promise<TimeSeriesPoint[]> {
  // Split into daily chunks to avoid GraphQL limit: 1000 truncation
  // (7 days × 24 hours × ~7 cache statuses ≈ 1176 groups, exceeds 1000)
  const chunks = splitDateRange(since, until);
  const chunkResults = await Promise.all(
    chunks.map((c) => fetchTimeSeriesChunk(zoneTag, c.since, c.until))
  );

  // Merge all chunks
  const merged = new Map<string, TimeSeriesPoint>();
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

async function fetchStatusCodes(zoneTag: string, since: string, until: string): Promise<StatusCodeGroup[]> {
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

  interface Group {
    count: number;
    dimensions: { edgeResponseStatus: number };
  }

  const data = await cfGraphQL<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(query);

  // Group by status class (2xx, 3xx, 4xx, 5xx)
  const classes = new Map<string, number>();
  for (const g of data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []) {
    const status = g.dimensions.edgeResponseStatus;
    const cls = `${Math.floor(status / 100)}xx`;
    classes.set(cls, (classes.get(cls) || 0) + g.count);
  }

  return Array.from(classes.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchTopPaths(zoneTag: string, since: string, until: string): Promise<TopItem[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 15
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { clientRequestPath }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { clientRequestPath: string };
  }

  const data = await cfGraphQL<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    name: g.dimensions.clientRequestPath || "/",
    value: g.count,
  }));
}

async function fetchTopCountries(zoneTag: string, since: string, until: string): Promise<GeoItem[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 20
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { clientCountryName }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { clientCountryName: string };
  }

  const data = await cfGraphQL<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    name: formatCountry(g.dimensions.clientCountryName),
    value: g.count,
  }));
}

async function fetchCacheStats(zoneTag: string, since: string, until: string): Promise<CacheStats> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { cacheStatus }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { cacheStatus: string };
  }

  const data = await cfGraphQL<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(query);

  let hit = 0;
  let total = 0;
  for (const g of data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []) {
    total += g.count;
    const status = g.dimensions.cacheStatus.toLowerCase();
    if (status === "hit" || status === "stale" || status === "revalidated") {
      hit += g.count;
    }
  }

  return {
    hit,
    miss: total - hit,
    total,
    ratio: total > 0 ? (hit / total) * 100 : 0,
  };
}

async function fetchContentTypes(zoneTag: string, since: string, until: string): Promise<ContentTypeItem[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 15
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { edgeResponseContentTypeName }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { edgeResponseContentTypeName: string };
  }

  const data = await cfGraphQL<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    name: g.dimensions.edgeResponseContentTypeName || "unknown",
    value: g.count,
  }));
}

async function fetchErrorTrend(zoneTag: string, since: string, until: string): Promise<ErrorTrendPoint[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 5000
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            edgeResponseStatus_geq: 400
          }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          dimensions { datetimeHour edgeResponseStatus }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { datetimeHour: string; edgeResponseStatus: number };
  }

  const data = await cfGraphQL<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(query);

  const byHour = new Map<string, ErrorTrendPoint>();
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

async function fetchBandwidthByCache(zoneTag: string, since: string, until: string): Promise<BandwidthCachePoint[]> {
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
            ) {
              dimensions { datetimeHour cacheStatus }
              sum { edgeResponseBytes }
            }
          }
        }
      }`;

      interface Group {
        dimensions: { datetimeHour: string; cacheStatus: string };
        sum: { edgeResponseBytes: number };
      }

      const data = await cfGraphQL<{ viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> } }>(query);
      return data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [];
    })
  );

  const byHour = new Map<string, BandwidthCachePoint>();
  const CACHED_STATUSES = new Set(["hit", "stale", "revalidated"]);
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
