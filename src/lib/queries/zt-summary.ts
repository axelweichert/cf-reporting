import { cfGraphQL, cfRestPaginated, fetchCategoryMap, fetchAppNameMap, fetchZtPlanInfo, type ZtPlanInfo } from "@/lib/use-cf-data";

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
  id: number;
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

interface DailyActiveUsers {
  date: string;
  uniqueUsers: number;
  logins: number;
}

export interface ComplianceMetric {
  label: string;
  value: number; // percentage 0-100
  detail: string;
  status: "good" | "warning" | "critical";
}

export interface ZtSummaryData {
  totalDnsQueries: number;
  blockedDnsQueries: number;
  resolverDecisions: ResolverDecisionItem[];
  blockedByPolicy: BlockedByPolicy[];
  topBlockedCategories: BlockedCategory[];
  accessLogins: AccessLoginSummary;
  fleet: FleetStats;
  plan: ZtPlanInfo | null;
  dailyActiveUsers: DailyActiveUsers[];
  compliance: ComplianceMetric[];
}

// --- Decision ID mapping (shared with gateway-dns) ---
const DECISION_NAMES: Record<number, string> = {
  1: "Allowed by Policy",
  2: "Allowed",
  9: "Blocked by Policy",
  14: "Blocked (Already Resolved)",
  15: "Allowed",
};

const BLOCKED_DECISION_IDS = new Set([9, 14]);

// --- Main fetch ---
export async function fetchZtSummaryData(
  accountTag: string,
  since: string,
  until: string
): Promise<ZtSummaryData> {
  const [resolverDecisions, blockedByPolicy, topBlockedCategories, accessLogins, fleet, categoryMap, plan, dailyActiveUsers] =
    await Promise.all([
      fetchResolverDecisions(accountTag, since, until),
      fetchBlockedByPolicy(accountTag, since, until),
      fetchTopBlockedCategories(accountTag, since, until),
      fetchAccessLogins(accountTag, since, until),
      fetchFleetStats(accountTag),
      fetchCategoryMap(accountTag),
      fetchZtPlanInfo(accountTag),
      fetchDailyActiveUsers(accountTag, since, until),
    ]);

  const totalDnsQueries = resolverDecisions.reduce((sum, d) => sum + d.count, 0);
  const blockedDnsQueries = resolverDecisions
    .filter((d) => BLOCKED_DECISION_IDS.has(d.id))
    .reduce((sum, d) => sum + d.count, 0);

  // Compute compliance metrics
  const compliance = computeComplianceMetrics(fleet, accessLogins, blockedDnsQueries, totalDnsQueries);

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
    plan,
    dailyActiveUsers,
    compliance,
  };
}

function computeComplianceMetrics(
  fleet: FleetStats,
  accessLogins: AccessLoginSummary,
  blockedDns: number,
  totalDns: number
): ComplianceMetric[] {
  const metrics: ComplianceMetric[] = [];

  // Device enrollment rate
  if (fleet.totalUsers > 0) {
    const enrollRate = fleet.totalDevices > 0
      ? Math.min(100, (fleet.totalDevices / fleet.totalUsers) * 100)
      : 0;
    const status = enrollRate >= 80 ? "good" : enrollRate >= 50 ? "warning" : "critical";
    metrics.push({
      label: "Device Enrollment",
      value: Math.round(enrollRate),
      detail: `${fleet.totalDevices} devices / ${fleet.totalUsers} users`,
      status,
    });
  }

  // Device activity rate
  if (fleet.totalDevices > 0) {
    const activeRate = (fleet.activeDevices / fleet.totalDevices) * 100;
    const status = activeRate >= 70 ? "good" : activeRate >= 40 ? "warning" : "critical";
    metrics.push({
      label: "Active Devices",
      value: Math.round(activeRate),
      detail: `${fleet.activeDevices} active in last 24h / ${fleet.totalDevices} total`,
      status,
    });
  }

  // Seat utilization
  if (fleet.gatewaySeats > 0 || fleet.accessSeats > 0) {
    const totalSeats = Math.max(fleet.gatewaySeats, fleet.accessSeats);
    const utilRate = totalSeats > 0 ? Math.min(100, (fleet.totalUsers / totalSeats) * 100) : 0;
    const status = utilRate >= 70 ? "good" : utilRate >= 40 ? "warning" : "critical";
    metrics.push({
      label: "Seat Utilization",
      value: Math.round(utilRate),
      detail: `${fleet.totalUsers} users / ${totalSeats} seats`,
      status,
    });
  }

  // Access login success rate
  if (accessLogins.total > 0) {
    const successRate = (accessLogins.successful / accessLogins.total) * 100;
    const status = successRate >= 90 ? "good" : successRate >= 70 ? "warning" : "critical";
    metrics.push({
      label: "Login Success Rate",
      value: Math.round(successRate),
      detail: `${accessLogins.successful} successful / ${accessLogins.total} total`,
      status,
    });
  }

  // DNS threat blocking rate
  if (totalDns > 0) {
    const blockRate = (blockedDns / totalDns) * 100;
    // Higher block rate isn't necessarily better - it's informational
    const status = blockRate <= 5 ? "good" : blockRate <= 15 ? "warning" : "critical";
    metrics.push({
      label: "DNS Threat Block Rate",
      value: Math.round(blockRate * 10) / 10,
      detail: `${formatNum(blockedDns)} blocked / ${formatNum(totalDns)} total queries`,
      status,
    });
  }

  // Access apps configured
  if (fleet.accessApps > 0) {
    const status = fleet.accessApps >= 5 ? "good" : fleet.accessApps >= 2 ? "warning" : "critical";
    metrics.push({
      label: "Access Apps",
      value: fleet.accessApps,
      detail: `${fleet.accessApps} applications protected by Access`,
      status,
    });
  }

  return metrics;
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
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

  const groups = data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || [];

  const byDecision = new Map<number, number>();
  for (const g of groups) {
    const decision = g.dimensions.resolverDecision;
    byDecision.set(decision, (byDecision.get(decision) || 0) + g.count);
  }

  return Array.from(byDecision.entries()).map(([id, count]) => ({
    id,
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

// ZT1: Seat utilization trend – count unique users who logged in per day
async function fetchDailyActiveUsers(
  accountTag: string,
  since: string,
  until: string
): Promise<DailyActiveUsers[]> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountTag}" }) {
        accessLoginRequestsAdaptiveGroups(
          limit: 1000
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            isSuccessfulLogin: 1
          }
          orderBy: [date_ASC]
        ) {
          count
          dimensions { date userUuid }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { date: string; userUuid: string };
  }

  try {
    const data = await cfGraphQL<{
      viewer: { accounts: Array<{ accessLoginRequestsAdaptiveGroups: Group[] }> };
    }>(query);

    const byDay = new Map<string, { users: Set<string>; logins: number }>();
    for (const g of data.viewer.accounts[0]?.accessLoginRequestsAdaptiveGroups || []) {
      const day = g.dimensions.date;
      const entry = byDay.get(day) || { users: new Set<string>(), logins: 0 };
      entry.users.add(g.dimensions.userUuid);
      entry.logins += g.count;
      byDay.set(day, entry);
    }

    return Array.from(byDay.entries())
      .map(([date, entry]) => ({ date, uniqueUsers: entry.users.size, logins: entry.logins }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}
