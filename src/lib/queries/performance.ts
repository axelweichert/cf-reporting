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
  city: string;
  country: string;
  requests: number;
  avgTtfb: number;
}

// Cloudflare edge location IATA codes → city + country
const COLO_MAP: Record<string, { city: string; country: string }> = {
  AMS: { city: "Amsterdam", country: "Netherlands" },
  ARN: { city: "Stockholm", country: "Sweden" },
  ATL: { city: "Atlanta", country: "United States" },
  BKK: { city: "Bangkok", country: "Thailand" },
  BOM: { city: "Mumbai", country: "India" },
  BOS: { city: "Boston", country: "United States" },
  BRU: { city: "Brussels", country: "Belgium" },
  BUD: { city: "Budapest", country: "Hungary" },
  CDG: { city: "Paris", country: "France" },
  CPH: { city: "Copenhagen", country: "Denmark" },
  DAL: { city: "Dallas", country: "United States" },
  DEL: { city: "New Delhi", country: "India" },
  DEN: { city: "Denver", country: "United States" },
  DFW: { city: "Dallas-Fort Worth", country: "United States" },
  DOH: { city: "Doha", country: "Qatar" },
  DUB: { city: "Dublin", country: "Ireland" },
  DUS: { city: "Düsseldorf", country: "Germany" },
  EWR: { city: "Newark", country: "United States" },
  EZE: { city: "Buenos Aires", country: "Argentina" },
  FCO: { city: "Rome", country: "Italy" },
  FRA: { city: "Frankfurt", country: "Germany" },
  GIG: { city: "Rio de Janeiro", country: "Brazil" },
  GRU: { city: "São Paulo", country: "Brazil" },
  HAM: { city: "Hamburg", country: "Germany" },
  HEL: { city: "Helsinki", country: "Finland" },
  HKG: { city: "Hong Kong", country: "Hong Kong" },
  HND: { city: "Tokyo", country: "Japan" },
  IAD: { city: "Ashburn", country: "United States" },
  IAH: { city: "Houston", country: "United States" },
  ICN: { city: "Seoul", country: "South Korea" },
  IST: { city: "Istanbul", country: "Turkey" },
  JNB: { city: "Johannesburg", country: "South Africa" },
  KIX: { city: "Osaka", country: "Japan" },
  KUL: { city: "Kuala Lumpur", country: "Malaysia" },
  LAX: { city: "Los Angeles", country: "United States" },
  LHR: { city: "London", country: "United Kingdom" },
  LIS: { city: "Lisbon", country: "Portugal" },
  MAD: { city: "Madrid", country: "Spain" },
  MAN: { city: "Manchester", country: "United Kingdom" },
  MEL: { city: "Melbourne", country: "Australia" },
  MEX: { city: "Mexico City", country: "Mexico" },
  MIA: { city: "Miami", country: "United States" },
  MRS: { city: "Marseille", country: "France" },
  MUC: { city: "Munich", country: "Germany" },
  MXP: { city: "Milan", country: "Italy" },
  NRT: { city: "Tokyo", country: "Japan" },
  ORD: { city: "Chicago", country: "United States" },
  OSL: { city: "Oslo", country: "Norway" },
  OTP: { city: "Bucharest", country: "Romania" },
  PDX: { city: "Portland", country: "United States" },
  PHL: { city: "Philadelphia", country: "United States" },
  PHX: { city: "Phoenix", country: "United States" },
  PRG: { city: "Prague", country: "Czech Republic" },
  QRO: { city: "Querétaro", country: "Mexico" },
  SCL: { city: "Santiago", country: "Chile" },
  SEA: { city: "Seattle", country: "United States" },
  SFO: { city: "San Francisco", country: "United States" },
  SIN: { city: "Singapore", country: "Singapore" },
  SJC: { city: "San Jose", country: "United States" },
  SOF: { city: "Sofia", country: "Bulgaria" },
  SYD: { city: "Sydney", country: "Australia" },
  TLV: { city: "Tel Aviv", country: "Israel" },
  TPE: { city: "Taipei", country: "Taiwan" },
  VIE: { city: "Vienna", country: "Austria" },
  WAW: { city: "Warsaw", country: "Poland" },
  YUL: { city: "Montreal", country: "Canada" },
  YVR: { city: "Vancouver", country: "Canada" },
  YYZ: { city: "Toronto", country: "Canada" },
  ZAG: { city: "Zagreb", country: "Croatia" },
  ZRH: { city: "Zurich", country: "Switzerland" },
};

function resolveColoCode(code: string): { city: string; country: string } {
  return COLO_MAP[code] || { city: code, country: "Unknown" };
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
