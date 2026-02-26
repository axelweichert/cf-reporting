import { cfGraphQL } from "@/lib/use-cf-data";

// --- Types ---

interface PerformanceTimeSeries {
  date: string;
  avgTtfb: number;
  avgOriginTime: number;
  requests: number;
}

interface ContentTypePerformance {
  contentType: string;
  requests: number;
  avgTtfb: number;
  avgOriginTime: number;
  avgResponseBytes: number;
}

interface CountryPerformance {
  country: string;
  requests: number;
  avgTtfb: number;
  avgOriginTime: number;
}

interface ProtocolDistribution {
  protocol: string;
  requests: number;
}

interface ColoPerformance {
  colo: string;
  requests: number;
  avgTtfb: number;
}

export interface PerformanceData {
  timeSeries: PerformanceTimeSeries[];
  contentTypePerf: ContentTypePerformance[];
  countryPerf: CountryPerformance[];
  protocolDistribution: ProtocolDistribution[];
  coloPerf: ColoPerformance[];
  stats: {
    totalRequests: number;
    avgTtfb: number;
    p95Ttfb: number;
    avgOriginTime: number;
    p95OriginTime: number;
    totalBytes: number;
  };
}

// --- Main fetch ---

export async function fetchPerformanceData(
  zoneTag: string,
  since: string,
  until: string
): Promise<PerformanceData> {
  const [overview, byContentType, byCountry, byProtocol, byColo] = await Promise.all([
    fetchOverview(zoneTag, since, until),
    fetchByContentType(zoneTag, since, until),
    fetchByCountry(zoneTag, since, until),
    fetchByProtocol(zoneTag, since, until),
    fetchByColo(zoneTag, since, until),
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

// --- Individual queries ---

async function fetchOverview(
  zoneTag: string,
  since: string,
  until: string
): Promise<{ timeSeries: PerformanceTimeSeries[]; stats: PerformanceData["stats"] }> {
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

  const data = await cfGraphQL<{
    viewer: {
      zones: Array<{
        total: TotalGroup[];
        timeSeries: TimeGroup[];
      }>;
    };
  }>(query);

  const zone = data.viewer.zones[0];
  const t = zone?.total[0];

  const timeSeries: PerformanceTimeSeries[] = (zone?.timeSeries || []).map((g) => ({
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

async function fetchByContentType(
  zoneTag: string,
  since: string,
  until: string
): Promise<ContentTypePerformance[]> {
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

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

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

async function fetchByCountry(
  zoneTag: string,
  since: string,
  until: string
): Promise<CountryPerformance[]> {
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

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  const countryNames = new Intl.DisplayNames(["en"], { type: "region" });

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [])
    .filter((g) => g.dimensions.clientCountryName)
    .map((g) => {
      const code = g.dimensions.clientCountryName;
      let name = code;
      try {
        const resolved = countryNames.of(code);
        if (resolved && resolved !== code) name = resolved;
      } catch { /* ignore */ }

      return {
        country: `${name} (${code})`,
        requests: g.count,
        avgTtfb: Math.round(g.avg.edgeTimeToFirstByteMs || 0),
        avgOriginTime: Math.round(g.avg.originResponseDurationMs || 0),
      };
    })
    .slice(0, 10);
}

async function fetchByProtocol(
  zoneTag: string,
  since: string,
  until: string
): Promise<ProtocolDistribution[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 10
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { clientRequestHTTPProtocol }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { clientRequestHTTPProtocol: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    protocol: g.dimensions.clientRequestHTTPProtocol || "Unknown",
    requests: g.count,
  }));
}

async function fetchByColo(
  zoneTag: string,
  since: string,
  until: string
): Promise<ColoPerformance[]> {
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

  interface Group {
    count: number;
    avg: { edgeTimeToFirstByteMs: number };
    dimensions: { coloCode: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [])
    .filter((g) => g.dimensions.coloCode)
    .map((g) => ({
      colo: g.dimensions.coloCode,
      requests: g.count,
      avgTtfb: Math.round(g.avg.edgeTimeToFirstByteMs || 0),
    }))
    .slice(0, 15);
}
