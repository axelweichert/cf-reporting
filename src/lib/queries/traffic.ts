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

export interface TrafficData {
  timeSeries: TimeSeriesPoint[];
  statusCodes: StatusCodeGroup[];
  topPaths: TopItem[];
  topCountries: GeoItem[];
  cache: CacheStats;
  totalRequests: number;
  totalBandwidth: number;
}

// --- Queries ---
export async function fetchTrafficData(
  zoneTag: string,
  since: string,
  until: string
): Promise<TrafficData> {
  const [timeSeries, statusCodes, topPaths, topCountries, cacheData] = await Promise.all([
    fetchTimeSeries(zoneTag, since, until),
    fetchStatusCodes(zoneTag, since, until),
    fetchTopPaths(zoneTag, since, until),
    fetchTopCountries(zoneTag, since, until),
    fetchCacheStats(zoneTag, since, until),
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
