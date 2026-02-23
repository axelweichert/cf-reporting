import { cfGraphQL } from "@/lib/use-cf-data";

// --- Types ---
interface BotScoreBucket {
  range: string;
  count: number;
}

interface BotDecision {
  name: string;
  value: number;
}

interface AutomatedTrafficPoint {
  date: string;
  automated: number;
  total: number;
  percentage: number;
}

interface BotUserAgent {
  userAgent: string;
  count: number;
}

interface BotPath {
  path: string;
  count: number;
}

interface VerifiedBotCategory {
  category: string;
  count: number;
}

export interface BotData {
  botScoreDistribution: BotScoreBucket[];
  botManagementDecisions: BotDecision[];
  automatedTrafficOverTime: AutomatedTrafficPoint[];
  topBotUserAgents: BotUserAgent[];
  botRequestsByPath: BotPath[];
  verifiedBotCategories: VerifiedBotCategory[];
}

// --- Queries ---
export async function fetchBotData(
  zoneTag: string,
  since: string,
  until: string
): Promise<BotData> {
  const [
    botScoreDistribution,
    botManagementDecisions,
    automatedTrafficOverTime,
    topBotUserAgents,
    botRequestsByPath,
    verifiedBotCategories,
  ] = await Promise.all([
    fetchBotScoreDistribution(zoneTag, since, until),
    fetchBotManagementDecisions(zoneTag, since, until),
    fetchAutomatedTrafficOverTime(zoneTag, since, until),
    fetchTopBotUserAgents(zoneTag, since, until),
    fetchBotRequestsByPath(zoneTag, since, until),
    fetchVerifiedBotCategories(zoneTag, since, until),
  ]);

  return {
    botScoreDistribution,
    botManagementDecisions,
    automatedTrafficOverTime,
    topBotUserAgents,
    botRequestsByPath,
    verifiedBotCategories,
  };
}

const BOT_SCORE_RANGES: Record<number, string> = {
  0: "0-9",
  10: "10-19",
  20: "20-29",
  30: "30-39",
  40: "40-49",
  50: "50-59",
  60: "60-69",
  70: "70-79",
  80: "80-89",
  90: "90-99",
};

async function fetchBotScoreDistribution(
  zoneTag: string,
  since: string,
  until: string
): Promise<BotScoreBucket[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 100
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
          }
          orderBy: [botScoreBucketBy10_ASC]
        ) {
          count
          dimensions { botScoreBucketBy10 }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { botScoreBucketBy10: number };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    range: BOT_SCORE_RANGES[g.dimensions.botScoreBucketBy10] ?? `${g.dimensions.botScoreBucketBy10}+`,
    count: g.count,
  }));
}

async function fetchBotManagementDecisions(
  zoneTag: string,
  since: string,
  until: string
): Promise<BotDecision[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 100
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { botManagementDecision }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { botManagementDecision: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    name: g.dimensions.botManagementDecision || "Unknown",
    value: g.count,
  }));
}

async function fetchAutomatedTrafficOverTime(
  zoneTag: string,
  since: string,
  until: string
): Promise<AutomatedTrafficPoint[]> {
  // Fetch automated (botScore < 30) and total traffic in parallel, both grouped by hour
  const automatedQuery = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 1000
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            botScore_lt: 30
          }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          dimensions { datetimeHour }
        }
      }
    }
  }`;

  const totalQuery = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 1000
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
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

  type Response = {
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  };

  const [automatedData, totalData] = await Promise.all([
    cfGraphQL<Response>(automatedQuery),
    cfGraphQL<Response>(totalQuery),
  ]);

  const automatedByHour = new Map<string, number>();
  for (const g of automatedData.viewer.zones[0]?.httpRequestsAdaptiveGroups || []) {
    automatedByHour.set(
      g.dimensions.datetimeHour,
      (automatedByHour.get(g.dimensions.datetimeHour) || 0) + g.count
    );
  }

  const totalByHour = new Map<string, number>();
  for (const g of totalData.viewer.zones[0]?.httpRequestsAdaptiveGroups || []) {
    totalByHour.set(
      g.dimensions.datetimeHour,
      (totalByHour.get(g.dimensions.datetimeHour) || 0) + g.count
    );
  }

  // Merge both maps, using total's keys as the base set of hours
  const allHours = new Set([...automatedByHour.keys(), ...totalByHour.keys()]);
  const result: AutomatedTrafficPoint[] = [];

  for (const hour of allHours) {
    const automated = automatedByHour.get(hour) || 0;
    const total = totalByHour.get(hour) || 0;
    result.push({
      date: hour,
      automated,
      total,
      percentage: total > 0 ? (automated / total) * 100 : 0,
    });
  }

  return result.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchTopBotUserAgents(
  zoneTag: string,
  since: string,
  until: string
): Promise<BotUserAgent[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 15
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            botScore_lt: 30
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { userAgent }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { userAgent: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    userAgent: g.dimensions.userAgent || "Empty",
    count: g.count,
  }));
}

async function fetchBotRequestsByPath(
  zoneTag: string,
  since: string,
  until: string
): Promise<BotPath[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 10
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            botScore_lt: 30
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
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    path: g.dimensions.clientRequestPath || "/",
    count: g.count,
  }));
}

async function fetchVerifiedBotCategories(
  zoneTag: string,
  since: string,
  until: string
): Promise<VerifiedBotCategory[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 10
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            verifiedBotCategory_neq: ""
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { verifiedBotCategory }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { verifiedBotCategory: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    category: g.dimensions.verifiedBotCategory,
    count: g.count,
  }));
}
