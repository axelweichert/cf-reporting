import { cfGraphQL, cfRest } from "@/lib/use-cf-data";

// --- Types ---

interface OriginStatusBreakdown {
  status: number;
  statusGroup: string;
  requests: number;
  avgResponseTime: number;
}

interface OriginTimeSeries {
  date: string;
  avgResponseTime: number;
  requests: number;
  errorRate: number;
}

interface HealthCheckEvent {
  datetime: string;
  name: string;
  status: string;
  originIp: string;
  responseStatus: number;
  rttMs: number;
  failureReason: string;
  region: string;
}

interface HealthCheckSummary {
  name: string;
  status: string;
  address: string;
  type: string;
  interval: number;
}

export interface OriginHealthData {
  statusBreakdown: OriginStatusBreakdown[];
  timeSeries: OriginTimeSeries[];
  healthChecks: HealthCheckSummary[];
  healthEvents: HealthCheckEvent[];
  hasHealthChecks: boolean;
  stats: {
    totalRequests: number;
    avgResponseTime: number;
    p95ResponseTime: number;
    errorRate5xx: number;
    originStatuses: number;
  };
}

// --- Helpers ---

function statusGroup(code: number): string {
  if (code === 0) return "No origin (cached/edge)";
  if (code < 200) return "1xx Informational";
  if (code < 300) return "2xx Success";
  if (code < 400) return "3xx Redirect";
  if (code < 500) return "4xx Client Error";
  return "5xx Server Error";
}

// --- Main fetch ---

export async function fetchOriginHealthData(
  zoneTag: string,
  since: string,
  until: string
): Promise<OriginHealthData> {
  const [overview, statusData, timeSeries, healthChecks, healthEvents] = await Promise.all([
    fetchOverview(zoneTag, since, until),
    fetchStatusBreakdown(zoneTag, since, until),
    fetchTimeSeries(zoneTag, since, until),
    fetchHealthChecks(zoneTag),
    fetchHealthEvents(zoneTag, since, until),
  ]);

  return {
    statusBreakdown: statusData,
    timeSeries,
    healthChecks,
    healthEvents,
    hasHealthChecks: healthChecks.length > 0,
    stats: overview,
  };
}

// --- Individual queries ---

async function fetchOverview(
  zoneTag: string,
  since: string,
  until: string
): Promise<OriginHealthData["stats"]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 1
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          avg { originResponseDurationMs }
          quantiles { originResponseDurationMsP95 }
          ratio { status5xx }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    avg: { originResponseDurationMs: number };
    quantiles: { originResponseDurationMsP95: number };
    ratio: { status5xx: number };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  const g = data.viewer.zones[0]?.httpRequestsAdaptiveGroups[0];

  return {
    totalRequests: g?.count || 0,
    avgResponseTime: Math.round(g?.avg.originResponseDurationMs || 0),
    p95ResponseTime: Math.round(g?.quantiles.originResponseDurationMsP95 || 0),
    errorRate5xx: g ? Math.round(g.ratio.status5xx * 1000) / 10 : 0,
    originStatuses: 0, // filled from status breakdown
  };
}

async function fetchStatusBreakdown(
  zoneTag: string,
  since: string,
  until: string
): Promise<OriginStatusBreakdown[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 50
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          avg { originResponseDurationMs }
          dimensions { originResponseStatus }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    avg: { originResponseDurationMs: number };
    dimensions: { originResponseStatus: number };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    status: g.dimensions.originResponseStatus,
    statusGroup: statusGroup(g.dimensions.originResponseStatus),
    requests: g.count,
    avgResponseTime: Math.round(g.avg.originResponseDurationMs || 0),
  }));
}

async function fetchTimeSeries(
  zoneTag: string,
  since: string,
  until: string
): Promise<OriginTimeSeries[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          avg { originResponseDurationMs }
          ratio { status5xx }
          dimensions { datetimeHour }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    avg: { originResponseDurationMs: number };
    ratio: { status5xx: number };
    dimensions: { datetimeHour: string };
  }

  const data = await cfGraphQL<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    date: g.dimensions.datetimeHour,
    avgResponseTime: Math.round(g.avg.originResponseDurationMs || 0),
    requests: g.count,
    errorRate: Math.round(g.ratio.status5xx * 1000) / 10,
  }));
}

async function fetchHealthChecks(zoneTag: string): Promise<HealthCheckSummary[]> {
  try {
    const checks = await cfRest<Array<{
      id: string;
      name: string;
      status: string;
      address: string;
      type: string;
      interval: number;
    }>>(`/zones/${zoneTag}/healthchecks`);

    return (Array.isArray(checks) ? checks : []).map((c) => ({
      name: c.name || c.address,
      status: c.status || "unknown",
      address: c.address,
      type: c.type || "HTTPS",
      interval: c.interval || 60,
    }));
  } catch {
    return [];
  }
}

async function fetchHealthEvents(
  zoneTag: string,
  since: string,
  until: string
): Promise<HealthCheckEvent[]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        healthCheckEventsAdaptive(
          limit: 50
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [datetime_DESC]
        ) {
          datetime
          healthCheckName
          healthStatus
          originIP
          originResponseStatus
          rttMs
          failureReason
          region
        }
      }
    }
  }`;

  interface Event {
    datetime: string;
    healthCheckName: string;
    healthStatus: string;
    originIP: string;
    originResponseStatus: number;
    rttMs: number;
    failureReason: string;
    region: string;
  }

  try {
    const data = await cfGraphQL<{
      viewer: { zones: Array<{ healthCheckEventsAdaptive: Event[] }> };
    }>(query);

    return (data.viewer.zones[0]?.healthCheckEventsAdaptive || []).map((e) => ({
      datetime: e.datetime,
      name: e.healthCheckName || "Unknown",
      status: e.healthStatus || "unknown",
      originIp: e.originIP || "",
      responseStatus: e.originResponseStatus || 0,
      rttMs: e.rttMs || 0,
      failureReason: e.failureReason || "",
      region: e.region || "",
    }));
  } catch {
    return [];
  }
}
