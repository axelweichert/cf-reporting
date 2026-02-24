import { cfGraphQL, cfRestPaginated, fetchCategoryMap, fetchAppNameMap } from "@/lib/use-cf-data";

// --- Types ---
interface BlockedByPolicy {
  name: string;
  value: number;
}

interface BlockedCategory {
  name: string;
  value: number;
}

interface AccessLoginSummary {
  total: number;
  successful: number;
}

interface ResolverDecisionItem {
  decision: string;
  count: number;
}

interface FleetStats {
  totalDevices: number;
  activeDevices: number;
  totalUsers: number;
  accessSeats: number;
  gatewaySeats: number;
  accessApps: number;
}

export interface ZtSummaryData {
  totalDnsQueries: number;
  blockedDnsQueries: number;
  resolverDecisions: ResolverDecisionItem[];
  blockedByPolicy: BlockedByPolicy[];
  topBlockedCategories: BlockedCategory[];
  accessLogins: AccessLoginSummary;
  fleet: FleetStats;
}

// --- Decision ID mapping (shared with gateway-dns) ---
const DECISION_NAMES: Record<number, string> = {
  1: "Allowed by Policy",
  2: "Allowed",
  9: "Blocked by Policy",
  14: "Blocked (Already Resolved)",
  15: "Allowed (Not Blocked)",
};

const BLOCKED_DECISIONS = new Set([9, 14]);

// --- Main fetch ---
export async function fetchZtSummaryData(
  accountTag: string,
  since: string,
  until: string
): Promise<ZtSummaryData> {
  const [resolverDecisions, blockedByPolicy, topBlockedCategories, accessLogins, fleet, categoryMap] =
    await Promise.all([
      fetchResolverDecisions(accountTag, since, until),
      fetchBlockedByPolicy(accountTag, since, until),
      fetchTopBlockedCategories(accountTag, since, until),
      fetchAccessLogins(accountTag, since, until),
      fetchFleetStats(accountTag),
      fetchCategoryMap(accountTag),
    ]);

  const totalDnsQueries = resolverDecisions.reduce((sum, d) => sum + d.count, 0);
  const blockedDnsQueries = resolverDecisions
    .filter((d) => d.decision.toLowerCase().includes("blocked"))
    .reduce((sum, d) => sum + d.count, 0);

  return {
    totalDnsQueries,
    blockedDnsQueries,
    resolverDecisions,
    blockedByPolicy,
    topBlockedCategories: topBlockedCategories.map((c) => ({
      ...c,
      name: categoryMap.get(Number(c.name)) || `Category ${c.name}`,
    })),
    accessLogins,
    fleet,
  };
}

// --- Individual queries ---

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
    decision: DECISION_NAMES[id] || `Unknown (${id})`,
    count,
  }));
}

async function fetchBlockedByPolicy(
  accountTag: string,
  since: string,
  until: string
): Promise<BlockedByPolicy[]> {
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
          dimensions { policyName }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { policyName: string };
  }

  const data = await cfGraphQL<{
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || []).map((g) => ({
    name: g.dimensions.policyName || "Unknown Policy",
    value: g.count,
  }));
}

async function fetchTopBlockedCategories(
  accountTag: string,
  since: string,
  until: string
): Promise<BlockedCategory[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        gatewayResolverByCategoryAdaptiveGroups(
          limit: 10
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
    name: String(g.dimensions.categoryId),
    value: g.count,
  }));
}

async function fetchAccessLogins(
  accountTag: string,
  since: string,
  until: string
): Promise<AccessLoginSummary> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        total: accessLoginRequestsAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
        }
        successful: accessLoginRequestsAdaptiveGroups(
          limit: 1
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            isSuccessfulLogin: 1
          }
        ) {
          count
        }
      }
    }
  }`;

  interface Group {
    count: number;
  }

  const data = await cfGraphQL<{
    viewer: {
      accounts: Array<{
        total: Group[];
        successful: Group[];
      }>;
    };
  }>(query);

  const account = data.viewer.accounts[0];
  const total = (account?.total || []).reduce((sum, g) => sum + g.count, 0);
  const successful = (account?.successful || []).reduce((sum, g) => sum + g.count, 0);

  return { total, successful };
}

// --- Fleet stats (devices, users, access apps) ---

interface CfDevice {
  id: string;
  last_seen?: string;
}

interface CfAccessUser {
  id: string;
  access_seat?: boolean;
  gateway_seat?: boolean;
}

async function fetchFleetStats(accountTag: string): Promise<FleetStats> {
  const [devices, users, accessApps] = await Promise.all([
    fetchDevicesSummary(accountTag),
    fetchUsersSummary(accountTag),
    fetchAccessAppsCount(accountTag),
  ]);

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const activeDevices = devices.filter((d) => {
    if (!d.last_seen) return false;
    return now - new Date(d.last_seen).getTime() < dayMs;
  }).length;

  const accessSeats = users.filter((u) => u.access_seat).length;
  const gatewaySeats = users.filter((u) => u.gateway_seat).length;

  return {
    totalDevices: devices.length,
    activeDevices,
    totalUsers: users.length,
    accessSeats,
    gatewaySeats,
    accessApps,
  };
}

async function fetchDevicesSummary(accountTag: string): Promise<CfDevice[]> {
  try {
    return await cfRestPaginated<CfDevice>(`/accounts/${accountTag}/devices`);
  } catch {
    return [];
  }
}

async function fetchUsersSummary(accountTag: string): Promise<CfAccessUser[]> {
  try {
    return await cfRestPaginated<CfAccessUser>(`/accounts/${accountTag}/access/users`);
  } catch {
    return [];
  }
}

async function fetchAccessAppsCount(accountTag: string): Promise<number> {
  try {
    const map = await fetchAppNameMap(accountTag);
    return map.size;
  } catch {
    return 0;
  }
}
