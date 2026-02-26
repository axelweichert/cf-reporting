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
  // L7 DDoS section
  ddosEventsOverTime: DdosTimeSeriesPoint[];
  ddosAttackVectors: AttackVector[];
  ddosTopPaths: AttackedPath[];
  totalDdosEvents: number;
  // Rate Limiting section
  rateLimitEventsOverTime: DdosTimeSeriesPoint[];
  rateLimitMethods: AttackVector[];
  rateLimitTopPaths: AttackedPath[];
  totalRateLimitEvents: number;
}

// --- Queries ---
export async function fetchDdosData(
  zoneTag: string,
  since: string,
  until: string
): Promise<DdosData> {
  const [
    ddosEventsOverTime,
    ddosAttackVectors,
    ddosTopPaths,
    rateLimitEventsOverTime,
    rateLimitMethods,
    rateLimitTopPaths,
  ] = await Promise.all([
    fetchFilteredEventsOverTime(zoneTag, since, until, ["l7ddos"], "block"),
    fetchFilteredAttackVectors(zoneTag, since, until, ["l7ddos"], "block"),
    fetchFilteredTopPaths(zoneTag, since, until, ["l7ddos"], "block"),
    fetchFilteredEventsOverTime(zoneTag, since, until, ["ratelimit"]),
    fetchFilteredAttackVectors(zoneTag, since, until, ["ratelimit"]),
    fetchFilteredTopPaths(zoneTag, since, until, ["ratelimit"]),
  ]);

  const totalDdosEvents = ddosEventsOverTime.reduce((sum, p) => sum + p.count, 0);
  const totalRateLimitEvents = rateLimitEventsOverTime.reduce((sum, p) => sum + p.count, 0);

  return {
    ddosEventsOverTime,
    ddosAttackVectors,
    ddosTopPaths,
    totalDdosEvents,
    rateLimitEventsOverTime,
    rateLimitMethods,
    rateLimitTopPaths,
    totalRateLimitEvents,
  };
}

async function fetchFilteredEventsOverTime(
  zoneTag: string,
  since: string,
  until: string,
  sources: string[],
  action?: string
): Promise<DdosTimeSeriesPoint[]> {
  const sourceFilter = `source_in: [${sources.map((s) => `"${s}"`).join(", ")}]`;
  const actionFilter = action ? `action: "${action}"` : "";
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 1000
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            ${actionFilter}
            ${sourceFilter}
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

async function fetchFilteredAttackVectors(
  zoneTag: string,
  since: string,
  until: string,
  sources: string[],
  action?: string
): Promise<AttackVector[]> {
  const sourceFilter = `source_in: [${sources.map((s) => `"${s}"`).join(", ")}]`;
  const actionFilter = action ? `action: "${action}"` : "";
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 10
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            ${actionFilter}
            ${sourceFilter}
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

async function fetchFilteredTopPaths(
  zoneTag: string,
  since: string,
  until: string,
  sources: string[],
  action?: string
): Promise<AttackedPath[]> {
  const sourceFilter = `source_in: [${sources.map((s) => `"${s}"`).join(", ")}]`;
  const actionFilter = action ? `action: "${action}"` : "";
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        firewallEventsAdaptiveGroups(
          limit: 10
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            ${actionFilter}
            ${sourceFilter}
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
