/**
 * Server-side zone-scoped report data fetchers for the data collector.
 *
 * Uses CloudflareClient directly (not the browser proxy).
 * Mirrors the query logic from src/lib/queries/ for 5 zone-scoped
 * report types: Origin Health, SSL, Bots, API Shield, DDoS.
 */

import { CloudflareClient } from "@/lib/cf-client";
import type { OriginHealthData } from "@/lib/queries/origin-health";
import type { SslData } from "@/lib/queries/ssl";
import type { BotData } from "@/lib/queries/bots";
import type { ApiShieldData } from "@/lib/queries/api-shield";
import type { DdosData, L34Attack, L34DdosData, RateLimitRule } from "@/lib/queries/ddos";

// --- Helpers ---

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

// ============================================================
// 1. Origin Health
// ============================================================

function statusGroup(code: number): string {
  if (code === 0) return "No origin (cached/edge)";
  if (code < 200) return "1xx Informational";
  if (code < 300) return "2xx Success";
  if (code < 400) return "3xx Redirect";
  if (code < 500) return "4xx Client Error";
  return "5xx Server Error";
}

export async function fetchOriginHealthDataServer(
  token: string,
  zoneId: string,
  since: string,
  until: string,
): Promise<OriginHealthData> {
  const client = new CloudflareClient(token);

  const [overview, statusData, timeSeries, healthChecks, healthEvents] = await Promise.all([
    fetchOriginOverview(client, zoneId, since, until),
    fetchOriginStatusBreakdown(client, zoneId, since, until),
    fetchOriginTimeSeries(client, zoneId, since, until),
    fetchHealthChecks(client, zoneId),
    fetchHealthEvents(client, zoneId, since, until),
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

async function fetchOriginOverview(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<OriginHealthData["stats"]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
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

  const data = await gql<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(client, query);

  const g = data.viewer.zones[0]?.httpRequestsAdaptiveGroups[0];

  return {
    totalRequests: g?.count || 0,
    avgResponseTime: Math.round(g?.avg.originResponseDurationMs || 0),
    p95ResponseTime: Math.round(g?.quantiles.originResponseDurationMsP95 || 0),
    errorRate5xx: g ? Math.round(g.ratio.status5xx * 1000) / 10 : 0,
    originStatuses: 0, // filled from status breakdown
  };
}

async function fetchOriginStatusBreakdown(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<OriginHealthData["statusBreakdown"]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
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

  const data = await gql<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(client, query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    status: g.dimensions.originResponseStatus,
    statusGroup: statusGroup(g.dimensions.originResponseStatus),
    requests: g.count,
    avgResponseTime: Math.round(g.avg.originResponseDurationMs || 0),
  }));
}

async function fetchOriginTimeSeries(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<OriginHealthData["timeSeries"]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
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

  const data = await gql<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(client, query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    date: g.dimensions.datetimeHour,
    avgResponseTime: Math.round(g.avg.originResponseDurationMs || 0),
    requests: g.count,
    errorRate: Math.round(g.ratio.status5xx * 1000) / 10,
  }));
}

async function fetchHealthChecks(
  client: CloudflareClient,
  zoneId: string,
): Promise<OriginHealthData["healthChecks"]> {
  try {
    const checks = await rest<Array<{
      id: string;
      name: string;
      status: string;
      address: string;
      type: string;
      interval: number;
    }>>(client, `/zones/${zoneId}/healthchecks`);

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
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<OriginHealthData["healthEvents"]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
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
    const data = await gql<{
      viewer: { zones: Array<{ healthCheckEventsAdaptive: Event[] }> };
    }>(client, query);

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

// ============================================================
// 2. SSL / TLS
// ============================================================

export async function fetchSslDataServer(
  token: string,
  zoneId: string,
  since: string,
  until: string,
): Promise<SslData> {
  const client = new CloudflareClient(token);

  const [protocolData, encryptionTs, certificates, settings] = await Promise.all([
    fetchProtocolDistribution(client, zoneId, since, until),
    fetchEncryptionTimeSeries(client, zoneId, since, until),
    fetchCertificates(client, zoneId),
    fetchSslSettings(client, zoneId),
  ]);

  const totalRequests = protocolData.matrix.reduce((sum, m) => sum + m.requests, 0);
  const encryptedRequests = protocolData.matrix
    .filter((m) => m.tlsVersion !== "none")
    .reduce((sum, m) => sum + m.requests, 0);
  const tlsv13Requests = protocolData.tlsVersions
    .filter((t) => t.version === "TLSv1.3")
    .reduce((sum, t) => sum + t.requests, 0);
  const http3Requests = protocolData.httpProtocols
    .filter((p) => p.protocol.includes("3"))
    .reduce((sum, p) => sum + p.requests, 0);

  return {
    tlsVersions: protocolData.tlsVersions,
    httpProtocols: protocolData.httpProtocols,
    protocolMatrix: protocolData.matrix,
    certificates,
    settings,
    encryptionTimeSeries: encryptionTs,
    stats: {
      totalRequests,
      encryptedRequests,
      encryptedPercent: totalRequests > 0 ? Math.round((encryptedRequests / totalRequests) * 10000) / 100 : 0,
      tlsv13Percent: totalRequests > 0 ? Math.round((tlsv13Requests / totalRequests) * 1000) / 10 : 0,
      http3Percent: totalRequests > 0 ? Math.round((http3Requests / totalRequests) * 1000) / 10 : 0,
      certCount: certificates.length,
    },
  };
}

async function fetchProtocolDistribution(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<{
  tlsVersions: SslData["tlsVersions"];
  httpProtocols: SslData["httpProtocols"];
  matrix: SslData["protocolMatrix"];
}> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
        httpRequestsAdaptiveGroups(
          limit: 50
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { clientSSLProtocol clientRequestHTTPProtocol }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { clientSSLProtocol: string; clientRequestHTTPProtocol: string };
  }

  const data = await gql<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(client, query);

  const groups = data.viewer.zones[0]?.httpRequestsAdaptiveGroups || [];

  // Build matrix
  const matrix: SslData["protocolMatrix"] = groups.map((g) => ({
    tlsVersion: g.dimensions.clientSSLProtocol || "none",
    httpProtocol: g.dimensions.clientRequestHTTPProtocol || "Unknown",
    requests: g.count,
  }));

  // Aggregate TLS versions
  const tlsMap = new Map<string, number>();
  for (const g of groups) {
    const v = g.dimensions.clientSSLProtocol || "none";
    tlsMap.set(v, (tlsMap.get(v) || 0) + g.count);
  }
  const tlsVersions = Array.from(tlsMap.entries())
    .map(([version, requests]) => ({ version, requests }))
    .sort((a, b) => b.requests - a.requests);

  // Aggregate HTTP protocols
  const httpMap = new Map<string, number>();
  for (const g of groups) {
    const p = g.dimensions.clientRequestHTTPProtocol || "Unknown";
    httpMap.set(p, (httpMap.get(p) || 0) + g.count);
  }
  const httpProtocols = Array.from(httpMap.entries())
    .map(([protocol, requests]) => ({ protocol, requests }))
    .sort((a, b) => b.requests - a.requests);

  return { tlsVersions, httpProtocols, matrix };
}

async function fetchEncryptionTimeSeries(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<SslData["encryptionTimeSeries"]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
        httpRequestsOverviewAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [datetimeHour_ASC]
        ) {
          sum { requests }
          ratio { encryptedRequests }
          dimensions { datetimeHour }
        }
      }
    }
  }`;

  interface Group {
    sum: { requests: number };
    ratio: { encryptedRequests: number };
    dimensions: { datetimeHour: string };
  }

  const data = await gql<{
    viewer: { zones: Array<{ httpRequestsOverviewAdaptiveGroups: Group[] }> };
  }>(client, query);

  return (data.viewer.zones[0]?.httpRequestsOverviewAdaptiveGroups || []).map((g) => {
    const total = g.sum.requests;
    const ratio = g.ratio.encryptedRequests || 0;
    return {
      date: g.dimensions.datetimeHour,
      totalRequests: total,
      encryptedRequests: Math.round(total * ratio),
      encryptedRatio: Math.round(ratio * 1000) / 10,
    };
  });
}

async function fetchCertificates(
  client: CloudflareClient,
  zoneId: string,
): Promise<SslData["certificates"]> {
  try {
    const packs = await rest<Array<{
      id: string;
      type: string;
      hosts: string[];
      status: string;
      certificate_authority: string;
      validity_days: number;
      certificates: Array<{
        id: string;
        signature: string;
        expires_on?: string;
      }>;
    }>>(client, `/zones/${zoneId}/ssl/certificate_packs`);

    return packs.map((p) => ({
      id: p.id,
      type: p.type || "unknown",
      hosts: p.hosts || [],
      status: p.status || "unknown",
      authority: p.certificate_authority || "unknown",
      validityDays: p.validity_days || 0,
      expiresOn: p.certificates?.[0]?.expires_on || null,
      signatureAlgorithms: [...new Set(p.certificates?.map((c) => c.signature) || [])],
    }));
  } catch {
    return [];
  }
}

async function fetchSslSettings(
  client: CloudflareClient,
  zoneId: string,
): Promise<SslData["settings"]> {
  const settingKeys = [
    "ssl", "min_tls_version", "tls_1_3", "always_use_https",
    "automatic_https_rewrites", "opportunistic_encryption", "0rtt", "http2", "http3",
  ];

  const results = await Promise.allSettled(
    settingKeys.map((key) =>
      rest<{ id: string; value: string }>(client, `/zones/${zoneId}/settings/${key}`)
    )
  );

  const values: Record<string, string> = {};
  for (let i = 0; i < settingKeys.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      values[settingKeys[i]] = r.value.value;
    }
  }

  return {
    mode: values.ssl || "unknown",
    minTlsVersion: values.min_tls_version || "unknown",
    tls13: values.tls_1_3 || "off",
    alwaysUseHttps: values.always_use_https === "on",
    autoHttpsRewrites: values.automatic_https_rewrites === "on",
    opportunisticEncryption: values.opportunistic_encryption === "on",
    zeroRtt: values["0rtt"] === "on",
    http2: values.http2 === "on",
    http3: values.http3 === "on",
  };
}

// ============================================================
// 3. Bot Management
// ============================================================

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

export async function fetchBotDataServer(
  token: string,
  zoneId: string,
  since: string,
  until: string,
): Promise<BotData> {
  const client = new CloudflareClient(token);

  // Bot Management fields require the Bot Management add-on.
  // Gracefully degrade if the zone doesn't have access.
  const [
    botScoreDistribution,
    botManagementDecisions,
    automatedTrafficOverTime,
    topBotUserAgents,
    botRequestsByPath,
    verifiedBotCategories,
    botTrend,
  ] = await Promise.all([
    fetchBotScoreDistribution(client, zoneId, since, until).catch(() => []),
    fetchBotManagementDecisions(client, zoneId, since, until).catch(() => []),
    fetchAutomatedTrafficOverTime(client, zoneId, since, until).catch(() => []),
    fetchTopBotUserAgents(client, zoneId, since, until).catch(() => []),
    fetchBotRequestsByPath(client, zoneId, since, until).catch(() => []),
    fetchVerifiedBotCategories(client, zoneId, since, until).catch(() => []),
    fetchBotTrend(client, zoneId, since, until).catch(() => ({ trend: [], verified: 0, unverified: 0 })),
  ]);

  return {
    botScoreDistribution,
    botManagementDecisions,
    automatedTrafficOverTime,
    topBotUserAgents,
    botRequestsByPath,
    verifiedBotCategories,
    botTrend: botTrend.trend,
    verifiedBotTotal: botTrend.verified,
    unverifiedBotTotal: botTrend.unverified,
  };
}

async function fetchBotScoreDistribution(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<BotData["botScoreDistribution"]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
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

  const data = await gql<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(client, query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    range: BOT_SCORE_RANGES[g.dimensions.botScoreBucketBy10] ?? `${g.dimensions.botScoreBucketBy10}+`,
    count: g.count,
  }));
}

async function fetchBotManagementDecisions(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<BotData["botManagementDecisions"]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
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

  const data = await gql<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(client, query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    name: g.dimensions.botManagementDecision || "Unknown",
    value: g.count,
  }));
}

async function fetchAutomatedTrafficOverTime(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<BotData["automatedTrafficOverTime"]> {
  const automatedQuery = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
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
      zones(filter: { zoneTag: "${zoneId}" }) {
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
    gql<Response>(client, automatedQuery),
    gql<Response>(client, totalQuery),
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

  const allHours = new Set([...automatedByHour.keys(), ...totalByHour.keys()]);
  const result: BotData["automatedTrafficOverTime"] = [];

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
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<BotData["topBotUserAgents"]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
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

  const data = await gql<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(client, query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    userAgent: g.dimensions.userAgent || "Empty",
    count: g.count,
  }));
}

async function fetchBotRequestsByPath(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<BotData["botRequestsByPath"]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
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

  const data = await gql<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(client, query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    path: g.dimensions.clientRequestPath || "/",
    count: g.count,
  }));
}

async function fetchVerifiedBotCategories(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<BotData["verifiedBotCategories"]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
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

  const data = await gql<{
    viewer: { zones: Array<{ httpRequestsAdaptiveGroups: Group[] }> };
  }>(client, query);

  return (data.viewer.zones[0]?.httpRequestsAdaptiveGroups || []).map((g) => ({
    category: g.dimensions.verifiedBotCategory,
    count: g.count,
  }));
}

async function fetchBotTrend(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<{ trend: BotData["botTrend"]; verified: number; unverified: number }> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
        verified: httpRequestsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", botScore_lt: 30, verifiedBotCategory_neq: "" }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          dimensions { datetimeHour }
        }
        unverified: httpRequestsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", botScore_lt: 30, verifiedBotCategory: "" }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          dimensions { datetimeHour }
        }
        human: httpRequestsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", botScore_geq: 30 }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          dimensions { datetimeHour }
        }
      }
    }
  }`;

  interface Group { count: number; dimensions: { datetimeHour: string } }

  const data = await gql<{
    viewer: {
      zones: Array<{
        verified: Group[];
        unverified: Group[];
        human: Group[];
      }>;
    };
  }>(client, query);

  const zone = data.viewer.zones[0];
  const byHour = new Map<string, { date: string; verified: number; unverified: number; human: number }>();

  let totalVerified = 0;
  let totalUnverified = 0;

  for (const g of zone?.verified || []) {
    const hour = g.dimensions.datetimeHour;
    const pt = byHour.get(hour) || { date: hour, verified: 0, unverified: 0, human: 0 };
    pt.verified += g.count;
    totalVerified += g.count;
    byHour.set(hour, pt);
  }
  for (const g of zone?.unverified || []) {
    const hour = g.dimensions.datetimeHour;
    const pt = byHour.get(hour) || { date: hour, verified: 0, unverified: 0, human: 0 };
    pt.unverified += g.count;
    totalUnverified += g.count;
    byHour.set(hour, pt);
  }
  for (const g of zone?.human || []) {
    const hour = g.dimensions.datetimeHour;
    const pt = byHour.get(hour) || { date: hour, verified: 0, unverified: 0, human: 0 };
    pt.human += g.count;
    byHour.set(hour, pt);
  }

  return {
    trend: Array.from(byHour.values()).sort((a, b) => a.date.localeCompare(b.date)),
    verified: totalVerified,
    unverified: totalUnverified,
  };
}

// ============================================================
// 4. API Shield
// ============================================================

export async function fetchApiShieldDataServer(
  token: string,
  zoneId: string,
  since: string,
  until: string,
): Promise<ApiShieldData> {
  const client = new CloudflareClient(token);

  const [managed, discovered, config, sessionTraffic, endpointTraffic] = await Promise.all([
    fetchManagedOperations(client, zoneId),
    fetchDiscoveredEndpoints(client, zoneId),
    fetchApiConfiguration(client, zoneId),
    fetchSessionTraffic(client, zoneId, since, until),
    fetchEndpointTraffic(client, zoneId, since, until),
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

async function fetchManagedOperations(
  client: CloudflareClient,
  zoneId: string,
): Promise<ApiShieldData["managedOperations"]> {
  try {
    const ops = await client.restPaginated<{
      operation_id: string;
      method: string;
      host: string;
      endpoint: string;
      last_updated: string;
    }>(`/zones/${zoneId}/api_gateway/operations`, 5);

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

async function fetchDiscoveredEndpoints(
  client: CloudflareClient,
  zoneId: string,
): Promise<ApiShieldData["discoveredEndpoints"]> {
  try {
    const res = await rest<Array<{
      id: string;
      method: string;
      host: string;
      endpoint: string;
      state: string;
      features?: { traffic_stats?: { requests?: number } };
    }>>(client, `/zones/${zoneId}/api_gateway/discovery/operations?per_page=100`);

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

async function fetchApiConfiguration(
  client: CloudflareClient,
  zoneId: string,
): Promise<string> {
  try {
    const config = await rest<{
      auth_id_characteristics?: Array<{ type: string; name: string }>;
    }>(client, `/zones/${zoneId}/api_gateway/configuration`);

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
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<ApiShieldData["sessionTraffic"]> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
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
    const data = await gql<{
      viewer: { zones: Array<{ apiGatewayMatchedSessionIDsPerEndpointFlattenedAdaptiveGroups: Group[] }> };
    }>(client, query);

    const byHour = new Map<string, { date: string; authenticated: number; unauthenticated: number }>();
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
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<Array<{ endpointId: string; endpointPath: string; requests: number; status2xx: number; status4xx: number; status5xx: number }>> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
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
    const data = await gql<{
      viewer: { zones: Array<{ apiGatewayMatchedSessionIDsPerEndpointAdaptiveGroups: Group[] }> };
    }>(client, query);

    const byEndpoint = new Map<string, { endpointId: string; endpointPath: string; requests: number; status2xx: number; status4xx: number; status5xx: number }>();
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

// ============================================================
// 5. DDoS
// ============================================================

export async function fetchDdosDataServer(
  token: string,
  zoneId: string,
  since: string,
  until: string,
  accountId?: string,
): Promise<DdosData> {
  const client = new CloudflareClient(token);

  const [
    ddosEventsOverTime,
    ddosAttackVectors,
    ddosTopPaths,
    rateLimitEventsOverTime,
    rateLimitMethods,
    rateLimitTopPaths,
    rawRules,
    triggersByRule,
    l34,
  ] = await Promise.all([
    fetchFilteredEventsOverTime(client, zoneId, since, until, ["l7ddos"]),
    fetchFilteredAttackVectors(client, zoneId, since, until, ["l7ddos"]),
    fetchFilteredTopPaths(client, zoneId, since, until, ["l7ddos"]),
    fetchFilteredEventsOverTime(client, zoneId, since, until, ["ratelimit"]),
    fetchFilteredAttackVectors(client, zoneId, since, until, ["ratelimit"]),
    fetchFilteredTopPaths(client, zoneId, since, until, ["ratelimit"]),
    fetchRateLimitRulesServer(client, zoneId),
    fetchRateLimitByRuleServer(client, zoneId, since, until),
    accountId ? fetchL34DdosData(client, accountId, since, until) : Promise.resolve(null),
  ]);

  const rateLimitRules = rawRules
    .map((r) => ({ ...r, triggers: triggersByRule.get(r.id) || 0 }))
    .sort((a, b) => b.triggers - a.triggers);

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

async function fetchFilteredEventsOverTime(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
  sources: string[],
): Promise<DdosData["ddosEventsOverTime"]> {
  const sourceFilter = `source_in: [${sources.map((s) => `"${s}"`).join(", ")}]`;
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
        firewallEventsAdaptiveGroups(
          limit: 1000
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
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

  const data = await gql<{
    viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> };
  }>(client, query);

  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).map((g) => ({
    date: g.dimensions.datetimeHour,
    count: g.count,
  }));
}

async function fetchFilteredAttackVectors(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
  sources: string[],
): Promise<DdosData["ddosAttackVectors"]> {
  const sourceFilter = `source_in: [${sources.map((s) => `"${s}"`).join(", ")}]`;
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
        firewallEventsAdaptiveGroups(
          limit: 10
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
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

  const data = await gql<{
    viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> };
  }>(client, query);

  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).map((g) => ({
    method: g.dimensions.clientRequestHTTPMethodName || "Unknown",
    count: g.count,
  }));
}

async function fetchFilteredTopPaths(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
  sources: string[],
): Promise<DdosData["ddosTopPaths"]> {
  const sourceFilter = `source_in: [${sources.map((s) => `"${s}"`).join(", ")}]`;
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
        firewallEventsAdaptiveGroups(
          limit: 10
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
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

  const data = await gql<{
    viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> };
  }>(client, query);

  return (data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []).map((g) => ({
    path: g.dimensions.clientRequestPath || "/",
    count: g.count,
  }));
}

async function fetchL34DdosData(
  client: CloudflareClient,
  accountTag: string,
  since: string,
  until: string,
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
    const data = await gql<{
      viewer: { accounts: Array<{ dosdAttackAnalyticsGroups: RawAttack[] }> };
    }>(client, query);

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

async function fetchRateLimitRulesServer(
  client: CloudflareClient,
  zoneId: string,
): Promise<RateLimitRule[]> {
  try {
    const res = await client.rest<{
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
    }>(`/zones/${zoneId}/rulesets/phases/http_ratelimit/entrypoint`);

    if (!res.success || !res.result) return [];

    return (res.result.rules || [])
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
        triggers: 0,
      }));
  } catch {
    return [];
  }
}

async function fetchRateLimitByRuleServer(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<Map<string, number>> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
        firewallEventsAdaptiveGroups(
          limit: 200
          filter: {
            datetime_geq: "${since}"
            datetime_lt: "${until}"
            source_in: ["ratelimit"]
          }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { ruleId }
        }
      }
    }
  }`;

  interface Group {
    count: number;
    dimensions: { ruleId: string };
  }

  try {
    const data = await gql<{
      viewer: { zones: Array<{ firewallEventsAdaptiveGroups: Group[] }> };
    }>(client, query);

    const map = new Map<string, number>();
    for (const g of data.viewer.zones[0]?.firewallEventsAdaptiveGroups || []) {
      const id = g.dimensions.ruleId;
      map.set(id, (map.get(id) || 0) + g.count);
    }
    return map;
  } catch {
    return new Map();
  }
}
