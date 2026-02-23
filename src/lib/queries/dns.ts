import { cfGraphQL, cfRest } from "@/lib/use-cf-data";

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
}

interface TopQueriedRecord {
  name: string;
  count: number;
}

export interface DnsData {
  queryVolumeByType: DnsTimeSeriesPoint[];
  queryTypes: string[];
  responseCodeBreakdown: ResponseCodeItem[];
  dnsRecords: DnsRecord[];
  topQueriedRecords: TopQueriedRecord[];
  nxdomainHotspots: TopQueriedRecord[];
  totalQueries: number;
}

// --- Queries ---
export async function fetchDnsData(
  zoneTag: string,
  since: string,
  until: string
): Promise<DnsData> {
  const [queryVolume, responseCodes, dnsRecords, topQueried, nxdomains] = await Promise.all([
    fetchQueryVolumeByType(zoneTag, since, until),
    fetchResponseCodes(zoneTag, since, until),
    fetchDnsRecords(zoneTag),
    fetchTopQueriedRecords(zoneTag, since, until),
    fetchNxdomainHotspots(zoneTag, since, until),
  ]);

  const totalQueries = responseCodes.reduce((sum, r) => sum + r.value, 0);

  return {
    queryVolumeByType: queryVolume.timeSeries,
    queryTypes: queryVolume.types,
    responseCodeBreakdown: responseCodes,
    dnsRecords,
    topQueriedRecords: topQueried,
    nxdomainHotspots: nxdomains,
    totalQueries,
  };
}

async function fetchQueryVolumeByType(
  zoneTag: string,
  since: string,
  until: string
): Promise<{ timeSeries: DnsTimeSeriesPoint[]; types: string[] }> {
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

  return {
    timeSeries: Array.from(byHour.values()).sort((a, b) =>
      (a.date as string).localeCompare(b.date as string)
    ),
    types: Array.from(types).sort(),
  };
}

async function fetchResponseCodes(
  zoneTag: string,
  since: string,
  until: string
): Promise<ResponseCodeItem[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        dnsAnalyticsAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { responseCode }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { responseCode: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ dnsAnalyticsAdaptiveGroups: Group[] }> };
  }>(query);

  const byCode = new Map<string, number>();
  for (const g of data.viewer.zones[0]?.dnsAnalyticsAdaptiveGroups || []) {
    const code = g.dimensions.responseCode || "UNKNOWN";
    byCode.set(code, (byCode.get(code) || 0) + g.count);
  }

  return Array.from(byCode.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

async function fetchDnsRecords(zoneTag: string): Promise<DnsRecord[]> {
  return cfRest<DnsRecord[]>(`/zones/${zoneTag}/dns_records?per_page=100`);
}

async function fetchTopQueriedRecords(
  zoneTag: string,
  since: string,
  until: string
): Promise<TopQueriedRecord[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        dnsAnalyticsAdaptiveGroups(
          limit: 20
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { queryName }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { queryName: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ dnsAnalyticsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.dnsAnalyticsAdaptiveGroups || []).map((g) => ({
    name: g.dimensions.queryName || "unknown",
    count: g.count,
  }));
}

async function fetchNxdomainHotspots(
  zoneTag: string,
  since: string,
  until: string
): Promise<TopQueriedRecord[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        dnsAnalyticsAdaptiveGroups(
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
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { queryName: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ dnsAnalyticsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.dnsAnalyticsAdaptiveGroups || []).map((g) => ({
    name: g.dimensions.queryName || "unknown",
    count: g.count,
  }));
}
