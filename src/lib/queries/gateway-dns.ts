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

interface PolicyBreakdown {
  policyName: string;
  allowed: number;
  blocked: number;
  total: number;
}

interface LocationBreakdown {
  location: string;
  total: number;
  blocked: number;
}

interface HttpInspectionData {
  totalRequests: number;
  byAction: Array<{ action: string; count: number }>;
  topHosts: Array<{ host: string; count: number }>;
  timeSeries: Array<{ date: string; count: number }>;
}

export interface GatewayDnsData {
  queryVolume: DnsQueryTimeSeriesPoint[];
  topBlockedDomains: BlockedDomain[];
  blockedCategories: BlockedCategoryItem[];
  resolverDecisions: ResolverDecisionItem[];
  topBlockedLocations: BlockedByLocation[];
  policyBreakdown: PolicyBreakdown[];
  locationBreakdown: LocationBreakdown[];
  httpInspection: HttpInspectionData | null;
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
  const [queryVolume, topBlockedDomains, blockedCategories, resolverDecisions, topBlockedLocations, categoryMap, userBreakdown, httpInspection] =
    await Promise.all([
      fetchDnsQueryVolume(accountTag, since, until),
      fetchTopBlockedDomains(accountTag, since, until),
      fetchBlockedCategories(accountTag, since, until),
      fetchResolverDecisions(accountTag, since, until),
      fetchTopBlockedLocations(accountTag, since, until),
      fetchCategoryMap(accountTag),
      fetchUserBreakdown(accountTag, since, until),
      fetchHttpInspection(accountTag, since, until),
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
    policyBreakdown: userBreakdown.policies,
    locationBreakdown: userBreakdown.locations,
    httpInspection,
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

// GD6: User-level breakdown (via policy and location)
const BLOCKED_DECISIONS = new Set([9, 14]);

async function fetchUserBreakdown(
  accountTag: string,
  since: string,
  until: string
): Promise<{ policies: PolicyBreakdown[]; locations: LocationBreakdown[] }> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        byPolicy: gatewayResolverQueriesAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { policyName resolverDecision }
        }
        byLocation: gatewayResolverQueriesAdaptiveGroups(
          limit: 50
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { locationName resolverDecision }
        }
      }
    }
  }`;

  interface PolicyGroup { count: number; dimensions: { policyName: string; resolverDecision: number } }
  interface LocationGroup { count: number; dimensions: { locationName: string; resolverDecision: number } }

  const data = await cfGraphQL<{
    viewer: {
      accounts: Array<{
        byPolicy: PolicyGroup[];
        byLocation: LocationGroup[];
      }>;
    };
  }>(query);

  const account = data.viewer.accounts[0];

  // Aggregate policies
  const policyMap = new Map<string, { allowed: number; blocked: number; total: number }>();
  for (const g of account?.byPolicy || []) {
    const name = g.dimensions.policyName || "No Policy";
    const existing = policyMap.get(name) || { allowed: 0, blocked: 0, total: 0 };
    existing.total += g.count;
    if (BLOCKED_DECISIONS.has(g.dimensions.resolverDecision)) {
      existing.blocked += g.count;
    } else {
      existing.allowed += g.count;
    }
    policyMap.set(name, existing);
  }
  const policies = Array.from(policyMap.entries())
    .map(([policyName, stats]) => ({ policyName, ...stats }))
    .sort((a, b) => b.total - a.total);

  // Aggregate locations
  const locationMap = new Map<string, { total: number; blocked: number }>();
  for (const g of account?.byLocation || []) {
    const name = g.dimensions.locationName || "Unknown Location";
    const existing = locationMap.get(name) || { total: 0, blocked: 0 };
    existing.total += g.count;
    if (BLOCKED_DECISIONS.has(g.dimensions.resolverDecision)) {
      existing.blocked += g.count;
    }
    locationMap.set(name, existing);
  }
  const locations = Array.from(locationMap.entries())
    .map(([location, stats]) => ({ location, ...stats }))
    .sort((a, b) => b.total - a.total);

  return { policies, locations };
}

// GD1/ZT4: Gateway HTTP inspection data
async function fetchHttpInspection(
  accountTag: string,
  since: string,
  until: string
): Promise<HttpInspectionData | null> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        byAction: gatewayL7RequestsAdaptiveGroups(
          limit: 10
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { action }
        }
        topHosts: gatewayL7RequestsAdaptiveGroups(
          limit: 15
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { httpHost }
        }
        timeSeries: gatewayL7RequestsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          dimensions { datetimeHour }
        }
      }
    }
  }`;

  interface ActionGroup { count: number; dimensions: { action: string } }
  interface HostGroup { count: number; dimensions: { httpHost: string } }
  interface TimeGroup { count: number; dimensions: { datetimeHour: string } }

  try {
    const data = await cfGraphQL<{
      viewer: {
        accounts: Array<{
          byAction: ActionGroup[];
          topHosts: HostGroup[];
          timeSeries: TimeGroup[];
        }>;
      };
    }>(query);

    const account = data.viewer.accounts[0];
    if (!account) return null;

    const byAction = (account.byAction || []).map((g) => ({
      action: g.dimensions.action || "unknown",
      count: g.count,
    }));

    const totalRequests = byAction.reduce((sum, a) => sum + a.count, 0);
    if (totalRequests === 0) return null;

    const topHosts = (account.topHosts || []).map((g) => ({
      host: g.dimensions.httpHost || "unknown",
      count: g.count,
    }));

    // Aggregate time series by hour
    const byHour = new Map<string, number>();
    for (const g of account.timeSeries || []) {
      const hour = g.dimensions.datetimeHour;
      byHour.set(hour, (byHour.get(hour) || 0) + g.count);
    }
    const timeSeries = Array.from(byHour.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return { totalRequests, byAction, topHosts, timeSeries };
  } catch {
    return null;
  }
}
