import { cfGraphQL, cfRest, cfRestPaginated } from "@/lib/use-cf-data";

// --- Types ---

interface ApiOperation {
  operationId: string;
  method: string;
  host: string;
  endpoint: string;
  lastUpdated: string;
}

interface DiscoveredEndpoint {
  method: string;
  host: string;
  endpoint: string;
  state: string;
  avgRequestsPerHour: number;
}

interface EndpointTraffic {
  endpointId: string;
  endpointPath: string;
  requests: number;
  status2xx: number;
  status4xx: number;
  status5xx: number;
}

interface SessionTrafficPoint {
  date: string;
  authenticated: number;
  unauthenticated: number;
}

interface MethodDistribution {
  method: string;
  count: number;
}

export interface ApiShieldData {
  managedOperations: ApiOperation[];
  discoveredEndpoints: DiscoveredEndpoint[];
  methodDistribution: MethodDistribution[];
  sessionTraffic: SessionTrafficPoint[];
  topEndpointTraffic: EndpointTraffic[];
  stats: {
    totalManaged: number;
    totalDiscovered: number;
    discoveredInReview: number;
    avgRequestsPerHour: number;
    sessionIdentifier: string;
  };
}

// --- Main fetch ---

export async function fetchApiShieldData(
  zoneTag: string,
  since: string,
  until: string
): Promise<ApiShieldData> {
  const [managed, discovered, config, sessionTraffic, endpointTraffic] = await Promise.all([
    fetchManagedOperations(zoneTag),
    fetchDiscoveredEndpoints(zoneTag),
    fetchConfiguration(zoneTag),
    fetchSessionTraffic(zoneTag, since, until),
    fetchEndpointTraffic(zoneTag, since, until),
  ]);

  // Method distribution from managed operations
  const methodCounts = new Map<string, number>();
  for (const op of managed) {
    methodCounts.set(op.method, (methodCounts.get(op.method) || 0) + 1);
  }
  const methodDistribution = Array.from(methodCounts.entries())
    .map(([method, count]) => ({ method, count }))
    .sort((a, b) => b.count - a.count);

  const inReview = discovered.filter((d) => d.state === "review").length;
  const avgReqs = discovered.length > 0
    ? Math.round(discovered.reduce((sum, d) => sum + d.avgRequestsPerHour, 0) / discovered.length * 10) / 10
    : 0;

  // Cross-reference endpoint IDs with managed operations to get readable paths
  const opMap = new Map<string, string>();
  for (const op of managed) {
    opMap.set(op.operationId, `${op.method} ${op.host}${op.endpoint}`);
  }
  const enrichedTraffic = endpointTraffic.map((t) => ({
    ...t,
    endpointPath: opMap.get(t.endpointId) || t.endpointId,
  }));

  return {
    managedOperations: managed.slice(0, 50),
    discoveredEndpoints: discovered.slice(0, 30),
    methodDistribution,
    sessionTraffic,
    topEndpointTraffic: enrichedTraffic,
    stats: {
      totalManaged: managed.length,
      totalDiscovered: discovered.length,
      discoveredInReview: inReview,
      avgRequestsPerHour: avgReqs,
      sessionIdentifier: config,
    },
  };
}

// --- Individual fetchers ---

async function fetchManagedOperations(zoneTag: string): Promise<ApiOperation[]> {
  try {
    const ops = await cfRestPaginated<{
      operation_id: string;
      method: string;
      host: string;
      endpoint: string;
      last_updated: string;
    }>(`/zones/${zoneTag}/api_gateway/operations`);

    return ops.map((o) => ({
      operationId: o.operation_id,
      method: o.method,
      host: o.host,
      endpoint: o.endpoint,
      lastUpdated: o.last_updated,
    }));
  } catch {
    return [];
  }
}

async function fetchDiscoveredEndpoints(zoneTag: string): Promise<DiscoveredEndpoint[]> {
  try {
    // Fetch first 100 discovered endpoints (they come paginated)
    const res = await cfRest<Array<{
      id: string;
      method: string;
      host: string;
      endpoint: string;
      state: string;
      features?: { traffic_stats?: { requests?: number } };
    }>>(`/zones/${zoneTag}/api_gateway/discovery/operations?per_page=100`);

    return (Array.isArray(res) ? res : []).map((d) => ({
      method: d.method,
      host: d.host,
      endpoint: d.endpoint,
      state: d.state || "review",
      avgRequestsPerHour: d.features?.traffic_stats?.requests || 0,
    }));
  } catch {
    return [];
  }
}

async function fetchConfiguration(zoneTag: string): Promise<string> {
  try {
    const config = await cfRest<{
      auth_id_characteristics?: Array<{ type: string; name: string }>;
    }>(`/zones/${zoneTag}/api_gateway/configuration`);

    if (config.auth_id_characteristics?.length) {
      const c = config.auth_id_characteristics[0];
      return `${c.type}: ${c.name}`;
    }
    return "Not configured";
  } catch {
    return "Not configured";
  }
}

async function fetchSessionTraffic(
  zoneTag: string,
  since: string,
  until: string
): Promise<SessionTrafficPoint[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        apiGatewayMatchedSessionIDsPerEndpointFlattenedAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          dimensions { datetimeHour apiGatewayMatchedSessionIdentifierType }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { datetimeHour: string; apiGatewayMatchedSessionIdentifierType: string };
  }

  try {
    const data = await cfGraphQL<{
      viewer: { zones: Array<{ apiGatewayMatchedSessionIDsPerEndpointFlattenedAdaptiveGroups: Group[] }> };
    }>(query);

    const byHour = new Map<string, SessionTrafficPoint>();
    for (const g of data.viewer.zones[0]?.apiGatewayMatchedSessionIDsPerEndpointFlattenedAdaptiveGroups || []) {
      const hour = g.dimensions.datetimeHour;
      const existing = byHour.get(hour) || { date: hour, authenticated: 0, unauthenticated: 0 };

      if (g.dimensions.apiGatewayMatchedSessionIdentifierType === "UNAUTHENTICATED") {
        existing.unauthenticated += g.count;
      } else {
        existing.authenticated += g.count;
      }
      byHour.set(hour, existing);
    }

    return Array.from(byHour.values()).sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

async function fetchEndpointTraffic(
  zoneTag: string,
  since: string,
  until: string
): Promise<EndpointTraffic[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        apiGatewayMatchedSessionIDsPerEndpointAdaptiveGroups(
          limit: 200
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { apiGatewayMatchedEndpointId responseStatusCode }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { apiGatewayMatchedEndpointId: string; responseStatusCode: number };
  }

  try {
    const data = await cfGraphQL<{
      viewer: { zones: Array<{ apiGatewayMatchedSessionIDsPerEndpointAdaptiveGroups: Group[] }> };
    }>(query);

    const byEndpoint = new Map<string, EndpointTraffic>();
    for (const g of data.viewer.zones[0]?.apiGatewayMatchedSessionIDsPerEndpointAdaptiveGroups || []) {
      const id = g.dimensions.apiGatewayMatchedEndpointId;
      const existing = byEndpoint.get(id) || { endpointId: id, endpointPath: id, requests: 0, status2xx: 0, status4xx: 0, status5xx: 0 };
      existing.requests += g.count;

      const code = g.dimensions.responseStatusCode;
      if (code >= 200 && code < 300) existing.status2xx += g.count;
      else if (code >= 400 && code < 500) existing.status4xx += g.count;
      else if (code >= 500) existing.status5xx += g.count;

      byEndpoint.set(id, existing);
    }

    return Array.from(byEndpoint.values())
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 20);
  } catch {
    return [];
  }
}
