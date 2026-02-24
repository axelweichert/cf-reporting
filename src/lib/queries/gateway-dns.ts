import { cfGraphQL, fetchCategoryMap } from "@/lib/use-cf-data";

// --- Types ---
interface DnsQueryTimeSeriesPoint {
  date: string;
  count: number;
}

interface BlockedDomain {
  domain: string;
  category: string;
  count: number;
}

interface BlockedCategoryItem {
  category: string;
  count: number;
}

interface ResolverDecisionItem {
  decision: string;
  count: number;
}

interface BlockedByLocation {
  location: string;
  count: number;
}

export interface GatewayDnsData {
  queryVolume: DnsQueryTimeSeriesPoint[];
  topBlockedDomains: BlockedDomain[];
  blockedCategories: BlockedCategoryItem[];
  resolverDecisions: ResolverDecisionItem[];
  topBlockedLocations: BlockedByLocation[];
}

// --- Decision ID mapping ---
const DECISION_NAMES: Record<number, string> = {
  1: "Allowed by Policy",
  2: "Allowed",
  9: "Blocked by Policy",
  14: "Blocked (Already Resolved)",
  15: "Allowed",
};

// --- Main fetch ---
export async function fetchGatewayDnsData(
  accountTag: string,
  since: string,
  until: string
): Promise<GatewayDnsData> {
  const [queryVolume, topBlockedDomains, blockedCategories, resolverDecisions, topBlockedLocations, categoryMap] =
    await Promise.all([
      fetchDnsQueryVolume(accountTag, since, until),
      fetchTopBlockedDomains(accountTag, since, until),
      fetchBlockedCategories(accountTag, since, until),
      fetchResolverDecisions(accountTag, since, until),
      fetchTopBlockedLocations(accountTag, since, until),
      fetchCategoryMap(accountTag),
    ]);

  return {
    queryVolume,
    topBlockedDomains,
    blockedCategories: blockedCategories.map((c) => ({
      ...c,
      category: categoryMap.get(Number(c.category)) || `Category ${c.category}`,
    })),
    resolverDecisions,
    topBlockedLocations,
  };
}

// --- Individual queries ---

async function fetchDnsQueryVolume(
  accountTag: string,
  since: string,
  until: string
): Promise<DnsQueryTimeSeriesPoint[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        gatewayResolverQueriesAdaptiveGroups(
          limit: 1000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
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
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(query);

  const byHour = new Map<string, number>();
  for (const g of data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || []) {
    const hour = g.dimensions.datetimeHour;
    byHour.set(hour, (byHour.get(hour) || 0) + g.count);
  }

  return Array.from(byHour.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchTopBlockedDomains(
  accountTag: string,
  since: string,
  until: string
): Promise<BlockedDomain[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        gatewayResolverQueriesAdaptiveGroups(
          limit: 50
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            resolverDecision: 9
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { queryName categoryNames }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { queryName: string; categoryNames: string[] };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || []).map((g) => {
    const names = g.dimensions.categoryNames;
    const category = Array.isArray(names) && names.length > 0 ? names.join(", ") : "Uncategorized";
    return {
      domain: g.dimensions.queryName || "unknown",
      category,
      count: g.count,
    };
  });
}

async function fetchBlockedCategories(
  accountTag: string,
  since: string,
  until: string
): Promise<BlockedCategoryItem[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        gatewayResolverByCategoryAdaptiveGroups(
          limit: 15
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            resolverDecision: 9
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { categoryId }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { categoryId: number };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ gatewayResolverByCategoryAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.accounts[0]?.gatewayResolverByCategoryAdaptiveGroups || []).map((g) => ({
    category: String(g.dimensions.categoryId),
    count: g.count,
  }));
}

async function fetchResolverDecisions(
  accountTag: string,
  since: string,
  until: string
): Promise<ResolverDecisionItem[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        gatewayResolverQueriesAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { resolverDecision }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { resolverDecision: number };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(query);

  const byDecision = new Map<number, number>();
  for (const g of data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || []) {
    const decision = g.dimensions.resolverDecision;
    byDecision.set(decision, (byDecision.get(decision) || 0) + g.count);
  }

  return Array.from(byDecision.entries()).map(([id, count]) => ({
    decision: DECISION_NAMES[id] || `unknown_${id}`,
    count,
  }));
}

async function fetchTopBlockedLocations(
  accountTag: string,
  since: string,
  until: string
): Promise<BlockedByLocation[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        gatewayResolverQueriesAdaptiveGroups(
          limit: 10
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            resolverDecision: 9
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { locationName }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { locationName: string };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || []).map((g) => ({
    location: g.dimensions.locationName || "Unknown Location",
    count: g.count,
  }));
}
