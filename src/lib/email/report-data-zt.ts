/**
 * Server-side report data fetchers for Zero Trust (account-scoped) reports.
 *
 * Uses CloudflareClient directly (not the browser proxy).
 * Mirrors the query logic from src/lib/queries/ for 6 ZT report types:
 *   - Gateway DNS
 *   - Gateway Network
 *   - Shadow IT
 *   - Devices & Users
 *   - ZT Summary
 *   - Access Audit
 */

import { CloudflareClient } from "@/lib/cf-client";
import type { GatewayDnsData } from "@/lib/queries/gateway-dns";
import type { GatewayNetworkData } from "@/lib/queries/gateway-network";
import type { ShadowItData, DiscoveredApp, UserAppMapping } from "@/lib/queries/shadow-it";
import type { DevicesUsersData, DeviceHealthMetric } from "@/lib/queries/devices-users";
import type { ZtSummaryData, ComplianceMetric } from "@/lib/queries/zt-summary";
import type { AccessAuditData, Anomaly } from "@/lib/queries/access-audit";
import type { ZtPlanInfo } from "@/lib/use-cf-data";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function gql<T>(client: CloudflareClient, query: string): Promise<T> {
  const res = await client.graphql<T>(query);
  if (res.errors?.length) throw new Error(res.errors[0].message);
  return res.data;
}

async function rest<T>(client: CloudflareClient, path: string): Promise<T> {
  const res = await client.rest<T>(path);
  if (!res.success) throw new Error(res.errors?.[0]?.message || "API request failed");
  return res.result;
}

function formatCountry(input: string): string {
  if (!input || input === "Unknown") return "Unknown";
  try {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    if (input.length === 2) {
      const name = names.of(input.toUpperCase());
      return name && name !== input ? `${name} (${input.toUpperCase()})` : input;
    }
  } catch { /* pass */ }
  return input;
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Shared REST helpers (used by multiple reports)
// ---------------------------------------------------------------------------

/** Fetch Gateway category ID -> name mapping */
async function fetchCategoryMap(
  client: CloudflareClient,
  accountId: string,
): Promise<Map<number, string>> {
  try {
    const categories = await rest<Array<{
      id: number;
      name: string;
      subcategories?: Array<{ id: number; name: string; subcategories?: Array<{ id: number; name: string }> }>;
    }>>(client, `/accounts/${accountId}/gateway/categories`);

    const map = new Map<number, string>();
    for (const cat of categories) {
      map.set(cat.id, cat.name);
      for (const sub of cat.subcategories || []) {
        map.set(sub.id, sub.name);
        for (const sub2 of sub.subcategories || []) {
          map.set(sub2.id, sub2.name);
        }
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Fetch Access app ID -> name mapping */
async function fetchAppNameMap(
  client: CloudflareClient,
  accountId: string,
): Promise<Map<string, string>> {
  try {
    const apps = await client.restPaginated<{ id: string; name: string }>(
      `/accounts/${accountId}/access/apps`, 10,
    );
    const map = new Map<string, string>();
    for (const app of apps) {
      map.set(app.id, app.name);
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Fetch Zero Trust plan info from account subscriptions */
async function fetchZtPlanInfo(
  client: CloudflareClient,
  accountId: string,
): Promise<ZtPlanInfo | null> {
  try {
    const subs = await rest<Array<{
      rate_plan: { id: string; public_name: string; is_contract: boolean };
      component_values: Array<{ name: string; value: number }>;
    }>>(client, `/accounts/${accountId}/subscriptions`);

    const ztSub = subs.find((s) =>
      s.rate_plan.id.startsWith("teams_") || s.rate_plan.public_name.toLowerCase().includes("zero trust"),
    );
    if (!ztSub) return null;

    const seatLimit = ztSub.component_values.find((c) => c.name === "users")?.value || 0;

    const featureMap: Record<string, string> = {
      browser_isolation_adv: "Browser Isolation",
      dlp: "DLP",
      casb: "CASB",
      dex: "DEX",
    };
    const features = ztSub.component_values
      .filter((c) => c.name !== "users" && c.value > 0 && featureMap[c.name])
      .map((c) => featureMap[c.name]);

    return {
      planName: ztSub.rate_plan.public_name,
      seatLimit,
      features,
      isContract: ztSub.rate_plan.is_contract,
    };
  } catch {
    return null;
  }
}

// ===========================================================================
// 1. Gateway DNS
// ===========================================================================

const DECISION_NAMES: Record<number, string> = {
  1: "Allowed by Policy",
  2: "Allowed",
  9: "Blocked by Policy",
  14: "Blocked (Already Resolved)",
  15: "Allowed",
};

const BLOCKED_DECISIONS = new Set([9, 14]);

export async function fetchGatewayDnsDataServer(
  token: string,
  accountId: string,
  since: string,
  until: string,
): Promise<GatewayDnsData> {
  const client = new CloudflareClient(token);

  const [queryVolume, topBlockedDomains, blockedCategoriesRaw, resolverDecisions, topBlockedLocations, categoryMap, userBreakdown, httpInspection] =
    await Promise.all([
      fetchDnsQueryVolume(client, accountId, since, until),
      fetchTopBlockedDomains(client, accountId, since, until),
      fetchBlockedCategories(client, accountId, since, until),
      fetchResolverDecisions(client, accountId, since, until),
      fetchTopBlockedLocations(client, accountId, since, until),
      fetchCategoryMap(client, accountId),
      fetchUserBreakdown(client, accountId, since, until),
      fetchHttpInspection(client, accountId, since, until),
    ]);

  return {
    queryVolume,
    topBlockedDomains,
    blockedCategories: blockedCategoriesRaw.map((c) => ({
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

// --- Gateway DNS sub-queries ---

async function fetchDnsQueryVolume(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<GatewayDnsData["queryVolume"]> {
  interface Group { count: number; dimensions: { datetimeHour: string } }

  const data = await gql<{
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
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
  }`);

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
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<GatewayDnsData["topBlockedDomains"]> {
  interface Group { count: number; dimensions: { queryName: string; categoryNames: string[] } }

  const data = await gql<{
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
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
  }`);

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
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<Array<{ category: string; count: number }>> {
  interface Group { count: number; dimensions: { categoryId: number } }

  const data = await gql<{
    viewer: { accounts: Array<{ gatewayResolverByCategoryAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
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
  }`);

  return (data.viewer.accounts[0]?.gatewayResolverByCategoryAdaptiveGroups || []).map((g) => ({
    category: String(g.dimensions.categoryId),
    count: g.count,
  }));
}

async function fetchResolverDecisions(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<GatewayDnsData["resolverDecisions"]> {
  interface Group { count: number; dimensions: { resolverDecision: number } }

  const data = await gql<{
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
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
  }`);

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
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<GatewayDnsData["topBlockedLocations"]> {
  interface Group { count: number; dimensions: { locationName: string } }

  const data = await gql<{
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
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
  }`);

  return (data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || []).map((g) => ({
    location: g.dimensions.locationName || "Unknown Location",
    count: g.count,
  }));
}

async function fetchUserBreakdown(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<{ policies: GatewayDnsData["policyBreakdown"]; locations: GatewayDnsData["locationBreakdown"] }> {
  interface PolicyGroup { count: number; dimensions: { policyName: string; resolverDecision: number } }
  interface LocationGroup { count: number; dimensions: { locationName: string; resolverDecision: number } }

  const data = await gql<{
    viewer: {
      accounts: Array<{
        byPolicy: PolicyGroup[];
        byLocation: LocationGroup[];
      }>;
    };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
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
  }`);

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

async function fetchHttpInspection(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<GatewayDnsData["httpInspection"]> {
  interface ActionGroup { count: number; dimensions: { action: string } }
  interface HostGroup { count: number; dimensions: { httpHost: string } }
  interface TimeGroup { count: number; dimensions: { datetimeHour: string } }

  try {
    const data = await gql<{
      viewer: {
        accounts: Array<{
          byAction: ActionGroup[];
          topHosts: HostGroup[];
          timeSeries: TimeGroup[];
        }>;
      };
    }>(client, `{
      viewer {
        accounts(filter: { accountTag: "${accountId}" }) {
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
    }`);

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

// ===========================================================================
// 2. Gateway Network
// ===========================================================================

const TRANSPORT_NAMES: Record<string, string> = {
  "0": "TCP",
  "1": "ICMP",
  "2": "UDP",
  "6": "TCP",
  "17": "UDP",
};

const PORT_SERVICES: Record<number, string> = {
  22: "SSH", 25: "SMTP", 53: "DNS", 80: "HTTP", 110: "POP3",
  143: "IMAP", 443: "HTTPS", 445: "SMB", 993: "IMAPS", 995: "POP3S",
  1433: "MSSQL", 1521: "Oracle", 3306: "MySQL", 3389: "RDP",
  5432: "PostgreSQL", 5900: "VNC", 6379: "Redis", 8080: "HTTP-Alt",
  8443: "HTTPS-Alt", 27017: "MongoDB",
};

export async function fetchGatewayNetworkDataServer(
  token: string,
  accountId: string,
  since: string,
  until: string,
): Promise<GatewayNetworkData> {
  const client = new CloudflareClient(token);

  const [sessionsOverTime, blockedDestinations, topSourceCountries, transportProtocols, portBreakdown] =
    await Promise.all([
      fetchSessionsOverTime(client, accountId, since, until),
      fetchBlockedDestinations(client, accountId, since, until),
      fetchTopSourceCountries(client, accountId, since, until),
      fetchTransportProtocols(client, accountId, since, until),
      fetchPortBreakdown(client, accountId, since, until),
    ]);

  return {
    sessionsOverTime,
    blockedDestinations,
    topSourceCountries,
    transportProtocols,
    portBreakdown,
  };
}

// --- Gateway Network sub-queries ---

async function fetchSessionsOverTime(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<GatewayNetworkData["sessionsOverTime"]> {
  interface Group { count: number; dimensions: { datetimeHour: string; action: string } }

  const data = await gql<{
    viewer: { accounts: Array<{ gatewayL4SessionsAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        gatewayL4SessionsAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          dimensions { datetimeHour action }
        }
      }
    }
  }`);

  const byHour = new Map<string, { date: string; allowed: number; blocked: number }>();
  for (const g of data.viewer.accounts[0]?.gatewayL4SessionsAdaptiveGroups || []) {
    const hour = g.dimensions.datetimeHour;
    const existing = byHour.get(hour) || { date: hour, allowed: 0, blocked: 0 };

    if (g.dimensions.action === "block") {
      existing.blocked += g.count;
    } else {
      existing.allowed += g.count;
    }

    byHour.set(hour, existing);
  }

  return Array.from(byHour.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchBlockedDestinations(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<GatewayNetworkData["blockedDestinations"]> {
  interface Group {
    count: number;
    dimensions: { destinationIp: string; dstIpCountry: string; destinationPort: number; transport: string };
  }

  const data = await gql<{
    viewer: { accounts: Array<{ gatewayL4SessionsAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        gatewayL4SessionsAdaptiveGroups(
          limit: 20
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            action: "block"
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { destinationIp dstIpCountry destinationPort transport }
        }
      }
    }
  }`);

  // Aggregate by IP, keeping the most common port/protocol/country
  const byIp = new Map<string, { count: number; country: string; port: number | null; protocol: string }>();
  for (const g of data.viewer.accounts[0]?.gatewayL4SessionsAdaptiveGroups || []) {
    const ip = g.dimensions.destinationIp || "unknown";
    const existing = byIp.get(ip);
    if (!existing || g.count > existing.count) {
      const raw = g.dimensions.transport != null ? String(g.dimensions.transport) : "";
      byIp.set(ip, {
        count: (existing?.count || 0) + g.count,
        country: formatCountry(g.dimensions.dstIpCountry || ""),
        port: g.dimensions.destinationPort || null,
        protocol: TRANSPORT_NAMES[raw] || raw || "unknown",
      });
    } else {
      existing.count += g.count;
    }
  }

  return Array.from(byIp.entries())
    .map(([ip, d]) => ({ ip, ...d }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

async function fetchTopSourceCountries(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<GatewayNetworkData["topSourceCountries"]> {
  interface Group { count: number; dimensions: { srcIpCountry: string } }

  const data = await gql<{
    viewer: { accounts: Array<{ gatewayL4SessionsAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        gatewayL4SessionsAdaptiveGroups(
          limit: 10
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { srcIpCountry }
        }
      }
    }
  }`);

  const byCountry = new Map<string, number>();
  for (const g of data.viewer.accounts[0]?.gatewayL4SessionsAdaptiveGroups || []) {
    const country = g.dimensions.srcIpCountry || "Unknown";
    byCountry.set(country, (byCountry.get(country) || 0) + g.count);
  }

  return Array.from(byCountry.entries())
    .map(([country, count]) => ({ country: formatCountry(country), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

async function fetchTransportProtocols(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<GatewayNetworkData["transportProtocols"]> {
  interface Group { count: number; dimensions: { transport: string } }

  const data = await gql<{
    viewer: { accounts: Array<{ gatewayL4SessionsAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        gatewayL4SessionsAdaptiveGroups(
          limit: 50
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { transport }
        }
      }
    }
  }`);

  const byProtocol = new Map<string, number>();
  for (const g of data.viewer.accounts[0]?.gatewayL4SessionsAdaptiveGroups || []) {
    const raw = g.dimensions.transport != null ? String(g.dimensions.transport) : "unknown";
    const protocol = TRANSPORT_NAMES[raw] || raw;
    byProtocol.set(protocol, (byProtocol.get(protocol) || 0) + g.count);
  }

  return Array.from(byProtocol.entries())
    .map(([protocol, count]) => ({ protocol, count }))
    .sort((a, b) => b.count - a.count);
}

async function fetchPortBreakdown(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<GatewayNetworkData["portBreakdown"]> {
  interface Group { count: number; dimensions: { destinationPort: number } }

  const data = await gql<{
    viewer: { accounts: Array<{ gatewayL4SessionsAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        gatewayL4SessionsAdaptiveGroups(
          limit: 30
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { destinationPort }
        }
      }
    }
  }`);

  const byPort = new Map<number, number>();
  for (const g of data.viewer.accounts[0]?.gatewayL4SessionsAdaptiveGroups || []) {
    const port = g.dimensions.destinationPort;
    if (port != null) {
      byPort.set(port, (byPort.get(port) || 0) + g.count);
    }
  }

  return Array.from(byPort.entries())
    .map(([port, count]) => ({
      port,
      service: PORT_SERVICES[port] || (port < 1024 ? "System" : "Custom"),
      count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}

// ===========================================================================
// 3. Shadow IT
// ===========================================================================

const BLOCKED_DECISION_IDS = new Set([9, 14]);

function parseAppName(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.join(", ");
  } catch { /* not JSON */ }
  return raw;
}

export async function fetchShadowItDataServer(
  token: string,
  accountId: string,
  since: string,
  until: string,
): Promise<ShadowItData> {
  const client = new CloudflareClient(token);

  const [discoveredApplications, categoryBreakdown, resolverDecisionsSummary, userAppMappings] = await Promise.all([
    fetchDiscoveredApplications(client, accountId, since, until),
    fetchShadowItCategoryBreakdown(client, accountId, since, until),
    fetchResolverDecisionsSummary(client, accountId, since, until),
    fetchUserAppMappings(client, accountId, since, until),
  ]);

  // Fetch usage trends for the top 5 discovered apps
  const top5 = discoveredApplications.slice(0, 5);
  const top5DisplayNames = top5.map((a) => a.name);
  const top5RawNames = top5.map((a) => a.rawName);
  const usageTrends = await fetchUsageTrends(client, accountId, since, until, top5RawNames, top5DisplayNames);

  // Detect if only blocked queries are logged
  const totalQueries = resolverDecisionsSummary.reduce((sum, d) => sum + d.count, 0);
  const blockedQueries = resolverDecisionsSummary
    .filter((d) => BLOCKED_DECISION_IDS.has(d.id))
    .reduce((sum, d) => sum + d.count, 0);
  const onlyBlockedLogged = totalQueries > 0 && blockedQueries === totalQueries && resolverDecisionsSummary.length === 1;

  return {
    discoveredApplications,
    categoryBreakdown,
    usageTrends,
    trendAppNames: top5DisplayNames,
    onlyBlockedLogged,
    userAppMappings,
  };
}

// --- Shadow IT sub-queries ---

async function fetchDiscoveredApplications(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<DiscoveredApp[]> {
  interface Group { count: number; dimensions: { matchedApplicationName: string; categoryNames: string[] } }

  const data = await gql<{
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        gatewayResolverQueriesAdaptiveGroups(
          limit: 30
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            matchedApplicationName_neq: ""
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { matchedApplicationName categoryNames }
        }
      }
    }
  }`);

  // Multiple groups may exist for the same app (different category combos).
  // Merge them, keeping the most common category.
  const appMap = new Map<string, { rawName: string; count: number; categories: Map<string, number> }>();

  for (const g of data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || []) {
    const raw = g.dimensions.matchedApplicationName;
    const name = parseAppName(raw) || "Unknown";
    const cats = Array.isArray(g.dimensions.categoryNames) && g.dimensions.categoryNames.length > 0
      ? g.dimensions.categoryNames
      : ["Uncategorized"];

    const existing = appMap.get(name) || { rawName: raw, count: 0, categories: new Map() };
    existing.count += g.count;
    const catKey = cats.join(", ");
    existing.categories.set(catKey, (existing.categories.get(catKey) || 0) + g.count);
    appMap.set(name, existing);
  }

  return Array.from(appMap.entries())
    .map(([name, { rawName, count, categories }]) => {
      // Pick the category with the most requests
      let topCategory = "Uncategorized";
      let topCount = 0;
      for (const [cat, c] of categories) {
        if (c > topCount) { topCategory = cat; topCount = c; }
      }
      return { name, rawName, category: topCategory, count };
    })
    .sort((a, b) => b.count - a.count);
}

async function fetchShadowItCategoryBreakdown(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<ShadowItData["categoryBreakdown"]> {
  interface Group { count: number; dimensions: { categoryNames: string[] } }

  const data = await gql<{
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        gatewayResolverQueriesAdaptiveGroups(
          limit: 50
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            matchedApplicationName: ""
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { categoryNames }
        }
      }
    }
  }`);

  const byCategory = new Map<string, number>();
  for (const g of data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || []) {
    const names = g.dimensions.categoryNames;
    const category = Array.isArray(names) && names.length > 0 ? names.join(", ") : "Uncategorized";
    byCategory.set(category, (byCategory.get(category) || 0) + g.count);
  }

  return Array.from(byCategory.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}

async function fetchUsageTrends(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
  rawNames: string[],
  displayNames: string[],
): Promise<ShadowItData["usageTrends"]> {
  if (rawNames.length === 0) return [];

  interface Group { count: number; dimensions: { datetimeHour: string } }

  // Fetch hourly data for each top app in parallel
  const appQueries = rawNames.map(async (rawName, i) => {
    const escapedName = rawName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const data = await gql<{
      viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
    }>(client, `{
      viewer {
        accounts(filter: { accountTag: "${accountId}" }) {
          gatewayResolverQueriesAdaptiveGroups(
            limit: 500
            filter: {
              datetime_geq: "${since}"
              datetime_lt: "${until}"
              matchedApplicationName: "${escapedName}"
            }
            orderBy: [datetimeHour_ASC]
          ) {
            count
            dimensions { datetimeHour }
          }
        }
      }
    }`);

    return {
      displayName: displayNames[i],
      groups: data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || [],
    };
  });

  const results = await Promise.all(appQueries);

  // Merge all app data into a single time series
  // AppUsageTrend = { date: string; [appName: string]: string | number }
  const byHour = new Map<string, { date: string; [key: string]: string | number }>();

  for (const { displayName, groups } of results) {
    for (const g of groups) {
      const hour = g.dimensions.datetimeHour;
      const existing = byHour.get(hour) || { date: hour };
      existing[displayName] = ((existing[displayName] as number) || 0) + g.count;
      byHour.set(hour, existing);
    }
  }

  // Ensure every time point has a value for each app (default to 0)
  const allPoints = Array.from(byHour.values());
  for (const point of allPoints) {
    for (const name of displayNames) {
      if (!(name in point)) {
        point[name] = 0;
      }
    }
  }

  return allPoints.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchResolverDecisionsSummary(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<Array<{ id: number; count: number }>> {
  interface Group { count: number; dimensions: { resolverDecision: number } }

  try {
    const data = await gql<{
      viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
    }>(client, `{
      viewer {
        accounts(filter: { accountTag: "${accountId}" }) {
          gatewayResolverQueriesAdaptiveGroups(
            limit: 20
            filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
            orderBy: [count_DESC]
          ) {
            count
            dimensions { resolverDecision }
          }
        }
      }
    }`);

    const byDecision = new Map<number, number>();
    for (const g of data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || []) {
      const id = g.dimensions.resolverDecision;
      byDecision.set(id, (byDecision.get(id) || 0) + g.count);
    }
    return Array.from(byDecision.entries()).map(([id, count]) => ({ id, count }));
  } catch {
    return [];
  }
}

async function fetchUserAppMappings(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<UserAppMapping[]> {
  interface Group { count: number; dimensions: { email: string; applicationNames: string[] } }

  try {
    const data = await gql<{
      viewer: { accounts: Array<{ gatewayL7RequestsAdaptiveGroups: Group[] }> };
    }>(client, `{
      viewer {
        accounts(filter: { accountTag: "${accountId}" }) {
          gatewayL7RequestsAdaptiveGroups(
            limit: 200
            filter: {
              datetime_geq: "${since}"
              datetime_lt: "${until}"
              email_neq: ""
            }
            orderBy: [count_DESC]
          ) {
            count
            dimensions { email applicationNames }
          }
        }
      }
    }`);

    // Aggregate: for each user, collect their unique apps and total requests
    const byUser = new Map<string, { apps: Set<string>; total: number }>();
    for (const g of data.viewer.accounts[0]?.gatewayL7RequestsAdaptiveGroups || []) {
      const email = g.dimensions.email;
      if (!email) continue;
      const existing = byUser.get(email) || { apps: new Set(), total: 0 };
      existing.total += g.count;
      for (const app of g.dimensions.applicationNames || []) {
        if (app) existing.apps.add(app);
      }
      byUser.set(email, existing);
    }

    return Array.from(byUser.entries())
      .map(([email, { apps, total }]) => ({
        email,
        apps: Array.from(apps).sort(),
        totalRequests: total,
      }))
      .sort((a, b) => b.totalRequests - a.totalRequests);
  } catch {
    return [];
  }
}

// ===========================================================================
// 4. Devices & Users (point-in-time snapshot, no date range)
// ===========================================================================

interface CfDevice {
  id: string;
  name?: string;
  device_type?: string;
  os_version?: string;
  version?: string;
  last_seen?: string;
  user?: {
    name?: string;
    email?: string;
    id?: string;
  };
}

interface CfAccessUser {
  id: string;
  name?: string;
  email?: string;
  access_seat?: boolean;
  gateway_seat?: boolean;
  seat_uid?: string;
  created_at?: string;
  updated_at?: string;
}

interface CfPostureRule {
  id: string;
  name?: string;
  type?: string;
  description?: string;
  match?: Array<{ platform?: string }>;
  input?: Record<string, unknown>;
}

function classifyDevice(lastSeenStr: string): "active" | "inactive" | "stale" {
  const lastSeen = new Date(lastSeenStr).getTime();
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;

  if (now - lastSeen < 24 * hourMs) return "active";
  if (now - lastSeen > 30 * dayMs) return "stale";
  return "inactive";
}

function formatOsName(platform: string | undefined, osVersion: string | undefined): string {
  if (!platform) return "Unknown";
  const p = platform.toLowerCase();
  if (p.includes("windows")) return "Windows";
  if (p.includes("mac") || p.includes("darwin")) return "macOS";
  if (p.includes("linux")) return "Linux";
  if (p.includes("ios")) return "iOS";
  if (p.includes("android")) return "Android";
  if (p.includes("chrome")) return "ChromeOS";
  return osVersion ? `${platform} ${osVersion}` : platform;
}

function formatPlatformName(platform: string): string {
  const names: Record<string, string> = {
    windows: "Windows",
    mac: "macOS",
    linux: "Linux",
    ios: "iOS",
    android: "Android",
    chromeos: "ChromeOS",
    all: "All platforms",
  };
  return names[platform] || platform;
}

export async function fetchDevicesUsersDataServer(
  token: string,
  accountId: string,
): Promise<DevicesUsersData> {
  const client = new CloudflareClient(token);

  const [rawDevices, rawUsers, postureResult, plan] = await Promise.all([
    fetchDevicesRest(client, accountId),
    fetchUsersRest(client, accountId),
    fetchPostureRules(client, accountId),
    fetchZtPlanInfo(client, accountId),
  ]);

  // Build user email -> device count map
  const userDeviceCount = new Map<string, number>();

  // Process devices
  const devices = rawDevices.map((d) => {
    const lastSeen = d.last_seen || new Date(0).toISOString();
    const email = d.user?.email || "";
    userDeviceCount.set(email, (userDeviceCount.get(email) || 0) + 1);

    return {
      name: d.name || d.id || "Unknown Device",
      user: d.user?.name || d.user?.email || "Unknown",
      email,
      os: formatOsName(d.device_type, d.os_version),
      osVersion: d.os_version || "",
      warpVersion: d.version || "Unknown",
      lastSeen,
      status: classifyDevice(lastSeen),
    };
  });

  // Process users
  const users = rawUsers.map((u) => ({
    name: u.name || "Unknown",
    email: u.email || "",
    accessSeat: u.access_seat ?? false,
    gatewaySeat: u.gateway_seat ?? false,
    deviceCount: userDeviceCount.get(u.email || "") || 0,
    lastLogin: u.updated_at || u.created_at || null,
  }));

  // Build platform -> device count map for posture scope
  const platformDeviceCount = new Map<string, number>();
  for (const d of devices) {
    const p = d.os.toLowerCase();
    if (p.includes("windows")) platformDeviceCount.set("windows", (platformDeviceCount.get("windows") || 0) + 1);
    else if (p.includes("macos") || p.includes("mac")) platformDeviceCount.set("mac", (platformDeviceCount.get("mac") || 0) + 1);
    else if (p.includes("linux")) platformDeviceCount.set("linux", (platformDeviceCount.get("linux") || 0) + 1);
    else if (p.includes("ios")) platformDeviceCount.set("ios", (platformDeviceCount.get("ios") || 0) + 1);
    else if (p.includes("android")) platformDeviceCount.set("android", (platformDeviceCount.get("android") || 0) + 1);
    else if (p.includes("chrome")) platformDeviceCount.set("chromeos", (platformDeviceCount.get("chromeos") || 0) + 1);
  }

  // Process posture rules with enriched details
  const postureRules = postureResult.rules.map((r) => {
    const platform = r.match?.[0]?.platform || "all";
    const deviceScope = platform === "all"
      ? devices.length
      : platformDeviceCount.get(platform) || 0;

    // Format input as human-readable requirement
    let input = "";
    if (r.input) {
      if (r.type === "os_version" && r.input.version) {
        input = `${r.input.operator || ">="} ${r.input.version}`;
      } else if (r.type === "application" && r.input.path) {
        input = `${r.input.running ? "Running" : "Installed"}: ${String(r.input.path).split(/[/\\]/).pop()}`;
      } else if (r.type === "disk_encryption") {
        input = "Disk encryption enabled";
      } else if (r.type === "file" && r.input.path) {
        input = `File ${r.input.exists ? "exists" : "absent"}: ${String(r.input.path).split(/[/\\]/).pop()}`;
      } else if (r.type === "intune") {
        input = `Intune: ${r.input.compliance_status || "compliant"}`;
      }
    }

    return {
      name: r.name || "Unnamed Rule",
      type: r.type || "Unknown",
      description: r.description || "",
      platform: formatPlatformName(platform),
      input,
      deviceScope,
    };
  });

  // Aggregate OS distribution
  const osCounts = new Map<string, number>();
  for (const d of devices) {
    osCounts.set(d.os, (osCounts.get(d.os) || 0) + 1);
  }
  const osDistribution = Array.from(osCounts.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  // Aggregate WARP version distribution
  const warpCounts = new Map<string, number>();
  for (const d of devices) {
    warpCounts.set(d.warpVersion, (warpCounts.get(d.warpVersion) || 0) + 1);
  }
  const warpVersionDistribution = Array.from(warpCounts.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 15);

  // Stats
  const activeDevices = devices.filter((d) => d.status === "active").length;
  const inactiveDevices = devices.filter((d) => d.status === "inactive").length;
  const staleDevices = devices.filter((d) => d.status === "stale").length;
  const accessSeats = users.filter((u) => u.accessSeat).length;
  const gatewaySeats = users.filter((u) => u.gatewaySeat).length;

  // Compute device health metrics
  const health = computeDeviceHealth(devices, users, {
    totalDevices: devices.length, activeDevices, inactiveDevices, staleDevices,
    totalUsers: users.length, accessSeats, gatewaySeats,
  });

  return {
    devices,
    users,
    postureRules,
    postureError: postureResult.error,
    osDistribution,
    warpVersionDistribution,
    plan,
    stats: {
      totalDevices: devices.length,
      activeDevices,
      inactiveDevices,
      staleDevices,
      totalUsers: users.length,
      accessSeats,
      gatewaySeats,
    },
    health,
  };
}

// --- Devices & Users REST sub-fetchers ---

async function fetchDevicesRest(client: CloudflareClient, accountId: string): Promise<CfDevice[]> {
  try {
    return await client.restPaginated<CfDevice>(`/accounts/${accountId}/devices`, 20);
  } catch {
    return [];
  }
}

async function fetchUsersRest(client: CloudflareClient, accountId: string): Promise<CfAccessUser[]> {
  try {
    return await client.restPaginated<CfAccessUser>(`/accounts/${accountId}/access/users`, 20);
  } catch {
    return [];
  }
}

async function fetchPostureRules(
  client: CloudflareClient,
  accountId: string,
): Promise<{ rules: CfPostureRule[]; error: string | null }> {
  try {
    const rules = await rest<CfPostureRule[]>(client, `/accounts/${accountId}/devices/posture`);
    return { rules, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to fetch posture rules";
    if (msg.includes("403") || msg.toLowerCase().includes("permission")) {
      return {
        rules: [],
        error: "Posture rules require additional permissions (Device Posture Read).",
      };
    }
    return { rules: [], error: msg };
  }
}

function computeDeviceHealth(
  devices: Array<{ status: string; warpVersion: string; os: string }>,
  users: Array<{ deviceCount: number }>,
  stats: {
    totalDevices: number; activeDevices: number; inactiveDevices: number;
    staleDevices: number; totalUsers: number; accessSeats: number; gatewaySeats: number;
  },
): DeviceHealthMetric[] {
  const metrics: DeviceHealthMetric[] = [];

  if (stats.totalDevices > 0) {
    // Active device rate
    const activeRate = (stats.activeDevices / stats.totalDevices) * 100;
    metrics.push({
      label: "Device Activity",
      value: Math.round(activeRate),
      detail: `${stats.activeDevices} active in last 24h / ${stats.totalDevices} total`,
      status: activeRate >= 60 ? "good" : activeRate >= 30 ? "warning" : "critical",
    });

    // Stale device rate (lower is better)
    const staleRate = (stats.staleDevices / stats.totalDevices) * 100;
    const staleHealthPct = 100 - Math.round(staleRate);
    metrics.push({
      label: "Fleet Freshness",
      value: staleHealthPct,
      detail: `${stats.staleDevices} devices inactive >30 days (${Math.round(staleRate)}%)`,
      status: staleRate <= 10 ? "good" : staleRate <= 30 ? "warning" : "critical",
    });

    // WARP version diversity
    const uniqueVersions = new Set(devices.map((d) => d.warpVersion)).size;
    const versionScore = uniqueVersions <= 3 ? 100 : uniqueVersions <= 6 ? 70 : uniqueVersions <= 10 ? 40 : 20;
    metrics.push({
      label: "WARP Version Consistency",
      value: versionScore,
      detail: `${uniqueVersions} distinct WARP versions deployed`,
      status: versionScore >= 70 ? "good" : versionScore >= 40 ? "warning" : "critical",
    });

    // OS diversity
    const uniqueOses = new Set(devices.map((d) => d.os)).size;
    metrics.push({
      label: "OS Coverage",
      value: Math.min(100, uniqueOses * 20),
      detail: `${uniqueOses} operating systems in fleet`,
      status: uniqueOses <= 4 ? "good" : uniqueOses <= 6 ? "warning" : "critical",
    });
  }

  // User coverage (users with devices enrolled)
  if (stats.totalUsers > 0) {
    const usersWithDevices = users.filter((u) => u.deviceCount > 0).length;
    const coverageRate = (usersWithDevices / stats.totalUsers) * 100;
    metrics.push({
      label: "User Enrollment",
      value: Math.round(coverageRate),
      detail: `${usersWithDevices} users with enrolled devices / ${stats.totalUsers} total`,
      status: coverageRate >= 80 ? "good" : coverageRate >= 50 ? "warning" : "critical",
    });
  }

  return metrics;
}

// ===========================================================================
// 5. ZT Summary
// ===========================================================================

export async function fetchZtSummaryDataServer(
  token: string,
  accountId: string,
  since: string,
  until: string,
): Promise<ZtSummaryData> {
  const client = new CloudflareClient(token);

  const [resolverDecisionsRaw, blockedByPolicy, topBlockedCategoriesRaw, accessLogins, fleet, categoryMap, plan, dailyActiveUsers] =
    await Promise.all([
      fetchZtResolverDecisions(client, accountId, since, until),
      fetchZtBlockedByPolicy(client, accountId, since, until),
      fetchZtTopBlockedCategories(client, accountId, since, until),
      fetchZtAccessLogins(client, accountId, since, until),
      fetchZtFleetStats(client, accountId),
      fetchCategoryMap(client, accountId),
      fetchZtPlanInfo(client, accountId),
      fetchZtDailyActiveUsers(client, accountId, since, until),
    ]);

  const totalDnsQueries = resolverDecisionsRaw.reduce((sum, d) => sum + d.count, 0);
  const blockedDnsQueries = resolverDecisionsRaw
    .filter((d) => BLOCKED_DECISION_IDS.has(d.id))
    .reduce((sum, d) => sum + d.count, 0);

  // Compute compliance metrics
  const compliance = computeComplianceMetrics(fleet, accessLogins, blockedDnsQueries, totalDnsQueries);

  return {
    totalDnsQueries,
    blockedDnsQueries,
    resolverDecisions: resolverDecisionsRaw,
    blockedByPolicy,
    topBlockedCategories: topBlockedCategoriesRaw.map((c) => ({
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

// --- ZT Summary sub-queries ---

async function fetchZtResolverDecisions(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<Array<{ id: number; decision: string; count: number }>> {
  interface Group { count: number; dimensions: { resolverDecision: number } }

  const data = await gql<{
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
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
  }`);

  const byDecision = new Map<number, number>();
  for (const g of data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || []) {
    const decision = g.dimensions.resolverDecision;
    byDecision.set(decision, (byDecision.get(decision) || 0) + g.count);
  }

  return Array.from(byDecision.entries()).map(([id, count]) => ({
    id,
    decision: DECISION_NAMES[id] || `Unknown (${id})`,
    count,
  }));
}

async function fetchZtBlockedByPolicy(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<ZtSummaryData["blockedByPolicy"]> {
  interface Group { count: number; dimensions: { policyName: string } }

  const data = await gql<{
    viewer: { accounts: Array<{ gatewayResolverQueriesAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
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
  }`);

  return (data.viewer.accounts[0]?.gatewayResolverQueriesAdaptiveGroups || []).map((g) => ({
    name: g.dimensions.policyName || "Unknown Policy",
    value: g.count,
  }));
}

async function fetchZtTopBlockedCategories(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<Array<{ name: string; value: number }>> {
  interface Group { count: number; dimensions: { categoryId: number } }

  const data = await gql<{
    viewer: { accounts: Array<{ gatewayResolverByCategoryAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
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
  }`);

  return (data.viewer.accounts[0]?.gatewayResolverByCategoryAdaptiveGroups || []).map((g) => ({
    name: String(g.dimensions.categoryId),
    value: g.count,
  }));
}

async function fetchZtAccessLogins(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<ZtSummaryData["accessLogins"]> {
  interface Group { count: number }

  const data = await gql<{
    viewer: {
      accounts: Array<{
        total: Group[];
        successful: Group[];
      }>;
    };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
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
  }`);

  const account = data.viewer.accounts[0];
  const total = (account?.total || []).reduce((sum, g) => sum + g.count, 0);
  const successful = (account?.successful || []).reduce((sum, g) => sum + g.count, 0);

  return { total, successful };
}

interface ZtFleetStats {
  totalDevices: number;
  activeDevices: number;
  totalUsers: number;
  accessSeats: number;
  gatewaySeats: number;
  accessApps: number;
}

async function fetchZtFleetStats(
  client: CloudflareClient,
  accountId: string,
): Promise<ZtFleetStats> {
  const [devices, users, accessApps] = await Promise.all([
    fetchDevicesRest(client, accountId),
    fetchUsersRest(client, accountId),
    fetchAccessAppsCount(client, accountId),
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

async function fetchAccessAppsCount(client: CloudflareClient, accountId: string): Promise<number> {
  try {
    const map = await fetchAppNameMap(client, accountId);
    return map.size;
  } catch {
    return 0;
  }
}

async function fetchZtDailyActiveUsers(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<ZtSummaryData["dailyActiveUsers"]> {
  interface Group { count: number; dimensions: { date: string; userUuid: string } }

  try {
    const data = await gql<{
      viewer: { accounts: Array<{ accessLoginRequestsAdaptiveGroups: Group[] }> };
    }>(client, `{
      viewer {
        accounts(filter: { accountTag: "${accountId}" }) {
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
    }`);

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

function computeComplianceMetrics(
  fleet: ZtFleetStats,
  accessLogins: { total: number; successful: number },
  blockedDns: number,
  totalDns: number,
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

// ===========================================================================
// 6. Access Audit
// ===========================================================================

export async function fetchAccessAuditDataServer(
  token: string,
  accountId: string,
  since: string,
  until: string,
): Promise<AccessAuditData> {
  const client = new CloudflareClient(token);

  const [loginsOverTime, rawAccessByApp, geographicAccess, identityProviders, failedLoginCount, rawFailedDetails, appNameMap, rawAppBreakdown] =
    await Promise.all([
      fetchAaLoginsOverTime(client, accountId, since, until),
      fetchAaAccessByApplication(client, accountId, since, until),
      fetchAaGeographicAccess(client, accountId, since, until),
      fetchAaIdentityProviders(client, accountId, since, until),
      fetchAaFailedLoginCount(client, accountId, since, until),
      fetchAaFailedLoginDetails(client, accountId, since, until),
      fetchAppNameMap(client, accountId),
      fetchAaPerAppBreakdown(client, accountId, since, until),
    ]);

  const accessByApplication = rawAccessByApp.map((item) => ({
    ...item,
    appName: appNameMap.get(item.appId) || null,
  }));

  const failedLoginDetails = rawFailedDetails.map((item) => ({
    ...item,
    appName: appNameMap.get(item.appId) || null,
  }));

  // Per-app success/failure breakdown
  const appMap = new Map<string, { successful: number; failed: number }>();
  for (const r of rawAppBreakdown) {
    const existing = appMap.get(r.appId) || { successful: 0, failed: 0 };
    if (r.isSuccess) existing.successful += r.count;
    else existing.failed += r.count;
    appMap.set(r.appId, existing);
  }
  const appBreakdown = Array.from(appMap.entries())
    .map(([appId, stats]) => {
      const total = stats.successful + stats.failed;
      return {
        appId,
        appName: appNameMap.get(appId) || null,
        ...stats,
        total,
        failureRate: total > 0 ? (stats.failed / total) * 100 : 0,
      };
    })
    .sort((a, b) => b.total - a.total);

  // Aggregate failed logins by app
  const failedByAppMap = new Map<string, number>();
  for (const d of failedLoginDetails) {
    failedByAppMap.set(d.appId, (failedByAppMap.get(d.appId) || 0) + d.count);
  }
  const failedByApp = Array.from(failedByAppMap.entries())
    .map(([appId, count]) => ({ appId, appName: appNameMap.get(appId) || null, count }))
    .sort((a, b) => b.count - a.count);

  // Aggregate failed logins by country
  const failedByCountryMap = new Map<string, number>();
  for (const d of failedLoginDetails) {
    failedByCountryMap.set(d.country, (failedByCountryMap.get(d.country) || 0) + d.count);
  }
  const failedByCountry = Array.from(failedByCountryMap.entries())
    .map(([country, count]) => ({ country, count }))
    .sort((a, b) => b.count - a.count);

  // Anomaly detection
  const anomalies = detectAnomalies(loginsOverTime, appBreakdown, geographicAccess, failedByCountry, identityProviders);

  return {
    loginsOverTime,
    accessByApplication,
    appBreakdown,
    geographicAccess,
    identityProviders,
    failedLoginCount,
    failedLoginDetails,
    failedByApp,
    failedByCountry,
    anomalies,
  };
}

// --- Access Audit sub-queries ---

interface LoginTimeSeriesPoint {
  date: string;
  successful: number;
  failed: number;
}

async function fetchAaLoginsOverTime(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<LoginTimeSeriesPoint[]> {
  interface Group { count: number; dimensions: { date: string } }

  const data = await gql<{
    viewer: {
      accounts: Array<{
        successful: Group[];
        failed: Group[];
      }>;
    };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        successful: accessLoginRequestsAdaptiveGroups(
          limit: 1000
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            isSuccessfulLogin: 1
          }
          orderBy: [date_ASC]
        ) {
          count
          dimensions { date }
        }
        failed: accessLoginRequestsAdaptiveGroups(
          limit: 1000
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            isSuccessfulLogin: 0
          }
          orderBy: [date_ASC]
        ) {
          count
          dimensions { date }
        }
      }
    }
  }`);

  const account = data.viewer.accounts[0];
  const byDate = new Map<string, LoginTimeSeriesPoint>();

  for (const g of account?.successful || []) {
    const date = g.dimensions.date;
    const existing = byDate.get(date) || { date, successful: 0, failed: 0 };
    existing.successful += g.count;
    byDate.set(date, existing);
  }

  for (const g of account?.failed || []) {
    const date = g.dimensions.date;
    const existing = byDate.get(date) || { date, successful: 0, failed: 0 };
    existing.failed += g.count;
    byDate.set(date, existing);
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchAaAccessByApplication(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<Array<{ appId: string; count: number }>> {
  interface Group { count: number; dimensions: { appId: string } }

  const data = await gql<{
    viewer: { accounts: Array<{ accessLoginRequestsAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        accessLoginRequestsAdaptiveGroups(
          limit: 15
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { appId }
        }
      }
    }
  }`);

  return (data.viewer.accounts[0]?.accessLoginRequestsAdaptiveGroups || []).map((g) => ({
    appId: g.dimensions.appId || "unknown",
    count: g.count,
  }));
}

async function fetchAaGeographicAccess(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<Array<{ country: string; count: number }>> {
  interface Group { count: number; dimensions: { country: string } }

  const data = await gql<{
    viewer: { accounts: Array<{ accessLoginRequestsAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        accessLoginRequestsAdaptiveGroups(
          limit: 15
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { country }
        }
      }
    }
  }`);

  return (data.viewer.accounts[0]?.accessLoginRequestsAdaptiveGroups || []).map((g) => ({
    country: formatCountry(g.dimensions.country),
    count: g.count,
  }));
}

async function fetchAaIdentityProviders(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<Array<{ provider: string; count: number }>> {
  interface Group { count: number; dimensions: { identityProvider: string } }

  const data = await gql<{
    viewer: { accounts: Array<{ accessLoginRequestsAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        accessLoginRequestsAdaptiveGroups(
          limit: 50
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { identityProvider }
        }
      }
    }
  }`);

  const byProvider = new Map<string, number>();
  for (const g of data.viewer.accounts[0]?.accessLoginRequestsAdaptiveGroups || []) {
    const provider = g.dimensions.identityProvider || "Unknown";
    byProvider.set(provider, (byProvider.get(provider) || 0) + g.count);
  }

  return Array.from(byProvider.entries())
    .map(([provider, count]) => ({ provider, count }))
    .sort((a, b) => b.count - a.count);
}

async function fetchAaFailedLoginCount(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<number> {
  interface Group { count: number }

  const data = await gql<{
    viewer: { accounts: Array<{ accessLoginRequestsAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        accessLoginRequestsAdaptiveGroups(
          limit: 1
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            isSuccessfulLogin: 0
          }
        ) {
          count
        }
      }
    }
  }`);

  return (data.viewer.accounts[0]?.accessLoginRequestsAdaptiveGroups || []).reduce(
    (sum, g) => sum + g.count,
    0,
  );
}

async function fetchAaFailedLoginDetails(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<Array<{ appId: string; country: string; identityProvider: string; count: number }>> {
  interface Group { count: number; dimensions: { appId: string; country: string; identityProvider: string } }

  const data = await gql<{
    viewer: { accounts: Array<{ accessLoginRequestsAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        accessLoginRequestsAdaptiveGroups(
          limit: 50
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            isSuccessfulLogin: 0
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { appId country identityProvider }
        }
      }
    }
  }`);

  return (data.viewer.accounts[0]?.accessLoginRequestsAdaptiveGroups || []).map((g) => ({
    appId: g.dimensions.appId || "unknown",
    country: formatCountry(g.dimensions.country),
    identityProvider: g.dimensions.identityProvider || "Unknown",
    count: g.count,
  }));
}

async function fetchAaPerAppBreakdown(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<Array<{ appId: string; isSuccess: boolean; count: number }>> {
  interface Group { count: number; dimensions: { appId: string; isSuccessfulLogin: number } }

  const data = await gql<{
    viewer: { accounts: Array<{ accessLoginRequestsAdaptiveGroups: Group[] }> };
  }>(client, `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        accessLoginRequestsAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { appId isSuccessfulLogin }
        }
      }
    }
  }`);

  return (data.viewer.accounts[0]?.accessLoginRequestsAdaptiveGroups || []).map((g) => ({
    appId: g.dimensions.appId || "unknown",
    isSuccess: g.dimensions.isSuccessfulLogin === 1,
    count: g.count,
  }));
}

// --- Anomaly detection (ported from access-audit.ts) ---

interface AppBreakdownForAnomaly {
  appId: string;
  appName: string | null;
  successful: number;
  failed: number;
  total: number;
  failureRate: number;
}

function detectAnomalies(
  loginTimeSeries: LoginTimeSeriesPoint[],
  appBreakdown: AppBreakdownForAnomaly[],
  geoAccess: Array<{ country: string; count: number }>,
  failedByCountry: Array<{ country: string; count: number }>,
  idpBreakdown: Array<{ provider: string; count: number }>,
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  // 1. Apps with high failure rate (>30% and at least 5 failures)
  for (const app of appBreakdown) {
    if (app.failureRate > 50 && app.failed >= 5) {
      anomalies.push({
        severity: "critical",
        title: `High failure rate on ${app.appName || app.appId}`,
        description: `${app.failureRate.toFixed(0)}% of login attempts failed (${app.failed} of ${app.total}). This could indicate a misconfigured identity provider, expired credentials, or a brute-force attack.`,
      });
    } else if (app.failureRate > 30 && app.failed >= 3) {
      anomalies.push({
        severity: "warning",
        title: `Elevated failure rate on ${app.appName || app.appId}`,
        description: `${app.failureRate.toFixed(0)}% of login attempts failed (${app.failed} of ${app.total}).`,
      });
    }
  }

  // 2. Countries with only failed logins (not in successful geo list)
  const successfulCountries = new Set(geoAccess.map((g) => g.country));
  for (const fc of failedByCountry) {
    if (!successfulCountries.has(fc.country) && fc.count >= 2) {
      anomalies.push({
        severity: "warning",
        title: `Suspicious country: ${fc.country}`,
        description: `${fc.count} failed login attempts from ${fc.country} with zero successful logins. This country has no legitimate access in the period.`,
      });
    }
  }

  // 3. Overall failure rate
  const totalSuccess = loginTimeSeries.reduce((s, p) => s + p.successful, 0);
  const totalFailed = loginTimeSeries.reduce((s, p) => s + p.failed, 0);
  const totalAll = totalSuccess + totalFailed;
  if (totalAll > 10 && totalFailed / totalAll > 0.2) {
    anomalies.push({
      severity: totalFailed / totalAll > 0.4 ? "critical" : "warning",
      title: "High overall failure rate",
      description: `${((totalFailed / totalAll) * 100).toFixed(1)}% of all login attempts failed (${totalFailed} of ${totalAll}). Investigate whether this is caused by misconfiguration or unauthorized access attempts.`,
    });
  }

  // 4. Spike detection -- days with failed logins > 3x the average
  const failedByDay = loginTimeSeries.filter((p) => p.failed > 0);
  if (failedByDay.length >= 3) {
    const avgFailed = failedByDay.reduce((s, p) => s + p.failed, 0) / failedByDay.length;
    for (const day of failedByDay) {
      if (day.failed > avgFailed * 3 && day.failed >= 5) {
        anomalies.push({
          severity: "warning",
          title: `Failure spike on ${day.date}`,
          description: `${day.failed} failed logins on this day, which is ${(day.failed / avgFailed).toFixed(1)}x the average (${avgFailed.toFixed(0)}).`,
        });
      }
    }
  }

  // 5. Identity provider with disproportionate failures
  if (idpBreakdown.length > 1) {
    const totalIdpLogins = idpBreakdown.reduce((s, p) => s + p.count, 0);
    for (const idp of idpBreakdown) {
      const share = idp.count / totalIdpLogins;
      if (share < 0.05 && idp.count >= 3) {
        anomalies.push({
          severity: "info",
          title: `Uncommon identity provider: ${idp.provider}`,
          description: `${idp.count} logins via ${idp.provider} (${(share * 100).toFixed(1)}% of total). Verify this provider is expected.`,
        });
      }
    }
  }

  return anomalies;
}
