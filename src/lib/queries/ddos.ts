import { cfGraphQL, cfRest } from "@/lib/use-cf-data";

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

// L3/L4 DDoS attack event from dosdAttackAnalyticsGroups
export interface L34Attack {
  attackType: string;
  attackVector: string;
  ipProtocol: string;
  destinationPort: number;
  mitigationType: string;
  packets: number;
  bits: number;
  droppedPackets: number;
  droppedBits: number;
  start: string;
  end: string;
}

export interface L34DdosData {
  attacks: L34Attack[];
  totalAttacks: number;
  totalPacketsDropped: number;
  totalBitsDropped: number;
}

export interface RateLimitRule {
  id: string;
  description: string;
  action: string;
  expression: string;
  enabled: boolean;
  threshold: number;
  period: number;
  mitigationTimeout: number;
  countingExpression: string;
  characteristics: string[];
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
  rateLimitRules: RateLimitRule[];
  // L3/L4 DDoS (requires Advanced DDoS / Magic Transit)
  l34: L34DdosData | null;
}

// --- Queries ---
export async function fetchDdosData(
  zoneTag: string,
  since: string,
  until: string,
  accountTag?: string
): Promise<DdosData> {
  const [
    ddosEventsOverTime,
    ddosAttackVectors,
    ddosTopPaths,
    rateLimitEventsOverTime,
    rateLimitMethods,
    rateLimitTopPaths,
    rateLimitRules,
    l34,
  ] = await Promise.all([
    fetchFilteredEventsOverTime(zoneTag, since, until, ["l7ddos"]),
    fetchFilteredAttackVectors(zoneTag, since, until, ["l7ddos"]),
    fetchFilteredTopPaths(zoneTag, since, until, ["l7ddos"]),
    fetchFilteredEventsOverTime(zoneTag, since, until, ["ratelimit"]),
    fetchFilteredAttackVectors(zoneTag, since, until, ["ratelimit"]),
    fetchFilteredTopPaths(zoneTag, since, until, ["ratelimit"]),
    fetchRateLimitRules(zoneTag),
    accountTag ? fetchL34DdosData(accountTag, since, until) : Promise.resolve(null),
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
    rateLimitRules,
    l34,
  };
}

// L3/L4 DDoS attack data (requires Advanced DDoS Protection / Magic Transit)
async function fetchL34DdosData(
  accountTag: string,
  since: string,
  until: string
): Promise<L34DdosData | null> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        dosdAttackAnalyticsGroups(
          limit: 50
          filter: {
            startDatetime_geq: "${since}"
            startDatetime_lt: "${until}"
          }
          orderBy: [startDatetime_DESC]
        ) {
          attackType
          attackVector
          ipProtocolName
          destinationPort
          mitigationType
          packets
          bits
          droppedPackets
          droppedBits
          startDatetime
          endDatetime
        }
      }
    }
  }`;

  interface RawAttack {
    attackType: string;
    attackVector: string;
    ipProtocolName: string;
    destinationPort: number;
    mitigationType: string;
    packets: number;
    bits: number;
    droppedPackets: number;
    droppedBits: number;
    startDatetime: string;
    endDatetime: string;
  }

  try {
    const data = await cfGraphQL<{
      viewer: { accounts: Array<{ dosdAttackAnalyticsGroups: RawAttack[] }> };
    }>(query);

    const attacks: L34Attack[] = (data.viewer.accounts[0]?.dosdAttackAnalyticsGroups || []).map((a) => ({
      attackType: a.attackType,
      attackVector: a.attackVector,
      ipProtocol: a.ipProtocolName,
      destinationPort: a.destinationPort,
      mitigationType: a.mitigationType,
      packets: a.packets,
      bits: a.bits,
      droppedPackets: a.droppedPackets,
      droppedBits: a.droppedBits,
      start: a.startDatetime,
      end: a.endDatetime,
    }));

    return {
      attacks,
      totalAttacks: attacks.length,
      totalPacketsDropped: attacks.reduce((s, a) => s + a.droppedPackets, 0),
      totalBitsDropped: attacks.reduce((s, a) => s + a.droppedBits, 0),
    };
  } catch {
    // Not available (requires Advanced DDoS / Magic Transit)
    return null;
  }
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

async function fetchRateLimitRules(zoneTag: string): Promise<RateLimitRule[]> {
  try {
    const ruleset = await cfRest<{
      id: string;
      rules?: Array<{
        id: string;
        description?: string;
        expression?: string;
        action?: string;
        enabled?: boolean;
        ratelimit?: {
          characteristics?: string[];
          period?: number;
          requests_per_period?: number;
          counting_expression?: string;
          mitigation_timeout?: number;
        };
      }>;
    }>(`/zones/${zoneTag}/rulesets/phases/http_ratelimit/entrypoint`);

    return (ruleset.rules || [])
      .filter((r) => r.ratelimit)
      .map((r) => ({
        id: r.id,
        description: r.description || "Untitled rule",
        action: r.action || "block",
        expression: r.expression || "",
        enabled: r.enabled !== false,
        threshold: r.ratelimit!.requests_per_period || 0,
        period: r.ratelimit!.period || 0,
        mitigationTimeout: r.ratelimit!.mitigation_timeout || 0,
        countingExpression: r.ratelimit!.counting_expression || "",
        characteristics: r.ratelimit!.characteristics || [],
      }));
  } catch {
    // Phase may not exist or no permission
    return [];
  }
}
