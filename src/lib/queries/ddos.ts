import { cfGraphQL } from "@/lib/use-cf-data";

// --- Types ---
interface DdosTimeSeriesPoint {
  date: string;
  count: number;
}

interface AttackVector {
  method: string;
  count: number;
}

interface AttackedPath {
  path: string;
  count: number;
}

export interface DdosData {
  ddosEventsOverTime: DdosTimeSeriesPoint[];
  attackVectors: AttackVector[];
  rateLimitEventsOverTime: DdosTimeSeriesPoint[];
  topAttackedPaths: AttackedPath[];
  totalDdosEvents: number;
  totalRateLimitEvents: number;
}

// --- Queries ---
export async function fetchDdosData(
  zoneTag: string,
  since: string,
  until: string
): Promise<DdosData> {
  const [ddosEventsOverTime, attackVectors, rateLimitEventsOverTime, topAttackedPaths] =
    await Promise.all([
      fetchDdosEventsOverTime(zoneTag, since, until),
      fetchAttackVectors(zoneTag, since, until),
      fetchRateLimitEventsOverTime(zoneTag, since, until),
      fetchTopAttackedPaths(zoneTag, since, until),
    ]);

  const totalDdosEvents = ddosEventsOverTime.reduce((sum, p) => sum + p.count, 0);
  const totalRateLimitEvents = rateLimitEventsOverTime.reduce((sum, p) => sum + p.count, 0);

  return {
    ddosEventsOverTime,
    attackVectors,
    rateLimitEventsOverTime,
    topAttackedPaths,
    totalDdosEvents,
    totalRateLimitEvents,
  };
}

async function fetchDdosEventsOverTime(
  zoneTag: string,
  since: string,
  until: string
): Promise<DdosTimeSeriesPoint[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 1000
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            action: "block"
            source_in: ["l7ddos"]
          }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          dimensions { datetimeHour }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { datetimeHour: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).map((g) => ({
    date: g.dimensions.datetimeHour,
    count: g.count,
  }));
}

async function fetchAttackVectors(
  zoneTag: string,
  since: string,
  until: string
): Promise<AttackVector[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 10
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            source_in: ["l7ddos"]
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { clientRequestHTTPMethodName }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { clientRequestHTTPMethodName: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).map((g) => ({
    method: g.dimensions.clientRequestHTTPMethodName || "Unknown",
    count: g.count,
  }));
}

async function fetchRateLimitEventsOverTime(
  zoneTag: string,
  since: string,
  until: string
): Promise<DdosTimeSeriesPoint[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 1000
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            source_in: ["ratelimit"]
          }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          dimensions { datetimeHour }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { datetimeHour: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).map((g) => ({
    date: g.dimensions.datetimeHour,
    count: g.count,
  }));
}

async function fetchTopAttackedPaths(
  zoneTag: string,
  since: string,
  until: string
): Promise<AttackedPath[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 10
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            source_in: ["l7ddos", "ratelimit"]
          }
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

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).map((g) => ({
    path: g.dimensions.clientRequestPath || "/",
    count: g.count,
  }));
}
