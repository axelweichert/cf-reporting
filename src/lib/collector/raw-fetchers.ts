/**
 * Raw data lake fetchers – one function per CF GraphQL dataset.
 *
 * Each fetcher consolidates what were previously dozens of separate queries
 * (across 16 report types) into a single GraphQL call using aliases.
 *
 * Zone-scoped:  ~7 GraphQL calls per zone   (down from ~100+)
 * Account-scoped: ~5 GraphQL calls per account
 *
 * Return types are flat arrays ready for INSERT OR REPLACE into raw_* tables.
 */

import { CloudflareClient } from "@/lib/cf-client";

// =============================================================================
// Helpers
// =============================================================================

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

function toEpoch(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function toHourBucket(epoch: number): number {
  return epoch - (epoch % 3600);
}

function toDayBucket(iso: string): number {
  const d = new Date(iso);
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// =============================================================================
// Return types
// =============================================================================

export interface RawHttpHourlyRow {
  ts: number;
  requests: number;
  bytes: number;
  cached_requests: number;
  cached_bytes: number;
  encrypted_requests: number;
  status_1xx: number;
  status_2xx: number;
  status_3xx: number;
  status_4xx: number;
  status_5xx: number;
  ttfb_avg: number | null;
  ttfb_p50: number | null;
  ttfb_p95: number | null;
  ttfb_p99: number | null;
  origin_time_avg: number | null;
  origin_time_p50: number | null;
  origin_time_p95: number | null;
  origin_time_p99: number | null;
}

export interface RawDimRow {
  ts: number;
  dim: string;
  key: string;
  requests: number;
  bytes: number;
  ttfb_avg: number | null;
  origin_avg: number | null;
}

export interface RawHttpOverviewRow {
  ts: number;
  requests: number;
  encrypted_requests: number;
}

export interface RawFwHourlyRow {
  ts: number;
  total: number;
  blocked: number;
  challenged: number;
  managed_challenged: number;
  js_challenged: number;
  challenge_solved: number;
  logged: number;
  skipped: number;
}

export interface RawFwDimRow {
  ts: number;
  dim: string;
  key: string;
  events: number;
  detail: string | null;
}

export interface RawDnsHourlyRow {
  ts: number;
  queries: number;
}

export interface RawDnsDimRow {
  ts: number;
  dim: string;
  key: string;
  queries: number;
}

export interface RawHealthEventRow {
  ts: number;
  name: string;
  origin_ip: string;
  status: string;
  response_status: number | null;
  rtt_ms: number | null;
  failure_reason: string | null;
  region: string | null;
}

export interface RawGwDnsHourlyRow {
  ts: number;
  total: number;
  blocked: number;
  allowed: number;
}

export interface RawGwDnsDimRow {
  ts: number;
  dim: string;
  key: string;
  queries: number;
  detail: string | null;
}

export interface RawGwNetHourlyRow {
  ts: number;
  allowed: number;
  blocked: number;
}

export interface RawGwNetDimRow {
  ts: number;
  dim: string;
  key: string;
  sessions: number;
  detail: string | null;
}

export interface RawGwHttpHourlyRow {
  ts: number;
  total: number;
}

export interface RawGwHttpDimRow {
  ts: number;
  dim: string;
  key: string;
  requests: number;
}

export interface RawAccessDailyRow {
  ts: number;
  successful: number;
  failed: number;
}

export interface RawAccessDimRow {
  ts: number;
  dim: string;
  key: string;
  logins: number;
  detail: string | null;
}

export interface RawDosdAttackRow {
  attack_id: string;
  attack_type: string | null;
  attack_vector: string | null;
  ip_protocol: string | null;
  destination_port: number | null;
  mitigation_type: string | null;
  packets: number | null;
  bits: number | null;
  dropped_packets: number | null;
  dropped_bits: number | null;
  start_time: number | null;
  end_time: number | null;
}

// Composite return types per dataset
export interface RawHttpResult {
  hourly: RawHttpHourlyRow[];
  dims: RawDimRow[];
}

export interface RawHttpOverviewResult {
  hourly: RawHttpOverviewRow[];
}

export interface RawFwResult {
  hourly: RawFwHourlyRow[];
  dims: RawFwDimRow[];
}

export interface RawDnsResult {
  hourly: RawDnsHourlyRow[];
  dims: RawDnsDimRow[];
}

export interface RawHealthResult {
  events: RawHealthEventRow[];
}

export interface RawGwDnsResult {
  hourly: RawGwDnsHourlyRow[];
  dims: RawGwDnsDimRow[];
}

export interface RawGwNetResult {
  hourly: RawGwNetHourlyRow[];
  dims: RawGwNetDimRow[];
}

export interface RawGwHttpResult {
  hourly: RawGwHttpHourlyRow[];
  dims: RawGwHttpDimRow[];
}

export interface RawAccessResult {
  daily: RawAccessDailyRow[];
  dims: RawAccessDimRow[];
}

export interface RawDosdResult {
  attacks: RawDosdAttackRow[];
}

// Aggregate return type for all zone data
export interface RawZoneData {
  http: RawHttpResult | null;
  httpOverview: RawHttpOverviewResult | null;
  firewall: RawFwResult | null;
  dns: RawDnsResult | null;
  health: RawHealthResult | null;
}

// Aggregate return type for all account data
export interface RawAccountData {
  gwDns: RawGwDnsResult | null;
  gwNet: RawGwNetResult | null;
  gwHttp: RawGwHttpResult | null;
  access: RawAccessResult | null;
  dosd: RawDosdResult | null;
}


// =============================================================================
// Zone fetchers
// =============================================================================

/**
 * Fetch raw HTTP data: hourly totals + dimensional breakdowns.
 * Combines 3 GraphQL alias groups into 2 calls.
 */
export async function fetchRawHttp(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<RawHttpResult> {
  // Call 1: Hourly totals + cache/status/country breakdowns
  const q1 = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
        byHour: httpRequestsAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          dimensions { datetimeHour }
          sum { edgeResponseBytes }
          avg { edgeTimeToFirstByteMs originResponseDurationMs }
          quantiles {
            edgeTimeToFirstByteMsP50 edgeTimeToFirstByteMsP95 edgeTimeToFirstByteMsP99
            originResponseDurationMsP50 originResponseDurationMsP95 originResponseDurationMsP99
          }
        }
        byCache: httpRequestsAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour cacheStatus }
          sum { edgeResponseBytes }
        }
        byStatus: httpRequestsAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour edgeResponseStatus }
        }
        byCountry: httpRequestsAdaptiveGroups(
          limit: 1000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { datetimeHour clientCountryName }
          sum { edgeResponseBytes }
        }
      }
    }
  }`;

  // Call 2: Top items + specialized dimensions
  const q2 = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
        byPath: httpRequestsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { datetimeHour clientRequestPath }
          sum { edgeResponseBytes }
        }
        byContentType: httpRequestsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { datetimeHour edgeResponseContentTypeName }
          sum { edgeResponseBytes }
          avg { edgeTimeToFirstByteMs originResponseDurationMs }
        }
        byMethod: httpRequestsAdaptiveGroups(
          limit: 200
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour clientRequestHTTPMethodName }
        }
        byOriginStatus: httpRequestsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour originResponseStatus }
          avg { originResponseDurationMs }
        }
        byColo: httpRequestsAdaptiveGroups(
          limit: 1000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { datetimeHour coloCode }
          avg { edgeTimeToFirstByteMs }
        }
        bySSLProto: httpRequestsAdaptiveGroups(
          limit: 200
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour clientSSLProtocol }
        }
        byHttpProto: httpRequestsAdaptiveGroups(
          limit: 200
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour clientRequestHTTPProtocol }
        }
        byBotScore: httpRequestsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour botScoreBucketBy10 }
        }
        byBotDecision: httpRequestsAdaptiveGroups(
          limit: 200
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour botManagementDecision }
        }
        byVerifiedBot: httpRequestsAdaptiveGroups(
          limit: 200
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour verifiedBotCategory }
        }
      }
    }
  }`;

  interface HourGroup {
    count: number;
    dimensions: { datetimeHour: string };
    sum?: { edgeResponseBytes: number };
    avg?: { edgeTimeToFirstByteMs: number; originResponseDurationMs: number };
    quantiles?: Record<string, number>;
  }
  interface CacheGroup {
    count: number;
    dimensions: { datetimeHour: string; cacheStatus: string };
    sum: { edgeResponseBytes: number };
  }
  interface StatusGroup {
    count: number;
    dimensions: { datetimeHour: string; edgeResponseStatus: number };
  }
  interface CountryGroup {
    count: number;
    dimensions: { datetimeHour: string; clientCountryName: string };
    sum: { edgeResponseBytes: number };
  }
  interface PathGroup {
    count: number;
    dimensions: { datetimeHour: string; clientRequestPath: string };
    sum: { edgeResponseBytes: number };
  }
  interface ContentTypeGroup {
    count: number;
    dimensions: { datetimeHour: string; edgeResponseContentTypeName: string };
    sum: { edgeResponseBytes: number };
    avg: { edgeTimeToFirstByteMs: number; originResponseDurationMs: number };
  }
  interface MethodGroup {
    count: number;
    dimensions: { datetimeHour: string; clientRequestHTTPMethodName: string };
  }
  interface OriginStatusGroup {
    count: number;
    dimensions: { datetimeHour: string; originResponseStatus: number };
    avg: { originResponseDurationMs: number };
  }
  interface ColoGroup {
    count: number;
    dimensions: { datetimeHour: string; coloCode: string };
    avg: { edgeTimeToFirstByteMs: number };
  }
  interface ProtoGroup {
    count: number;
    dimensions: { datetimeHour: string; [k: string]: string };
  }
  interface BotScoreGroup {
    count: number;
    dimensions: { datetimeHour: string; botScoreBucketBy10: number };
  }
  interface BotDecisionGroup {
    count: number;
    dimensions: { datetimeHour: string; botManagementDecision: string };
  }
  interface VerifiedBotGroup {
    count: number;
    dimensions: { datetimeHour: string; verifiedBotCategory: string };
  }

  type ZoneQ1 = {
    byHour: HourGroup[];
    byCache: CacheGroup[];
    byStatus: StatusGroup[];
    byCountry: CountryGroup[];
  };
  type ZoneQ2 = {
    byPath: PathGroup[];
    byContentType: ContentTypeGroup[];
    byMethod: MethodGroup[];
    byOriginStatus: OriginStatusGroup[];
    byColo: ColoGroup[];
    bySSLProto: ProtoGroup[];
    byHttpProto: ProtoGroup[];
    byBotScore: BotScoreGroup[];
    byBotDecision: BotDecisionGroup[];
    byVerifiedBot: VerifiedBotGroup[];
  };

  const [d1, d2] = await Promise.all([
    gql<{ viewer: { zones: ZoneQ1[] } }>(client, q1),
    gql<{ viewer: { zones: ZoneQ2[] } }>(client, q2),
  ]);

  const z1 = d1.viewer.zones[0] ?? { byHour: [], byCache: [], byStatus: [], byCountry: [] };
  const z2 = d2.viewer.zones[0] ?? {
    byPath: [], byContentType: [], byMethod: [], byOriginStatus: [],
    byColo: [], bySSLProto: [], byHttpProto: [], byBotScore: [],
    byBotDecision: [], byVerifiedBot: [],
  };

  // Build hourly rows
  const hourlyMap = new Map<number, RawHttpHourlyRow>();

  for (const g of z1.byHour) {
    const ts = toHourBucket(toEpoch(g.dimensions.datetimeHour));
    hourlyMap.set(ts, {
      ts,
      requests: g.count,
      bytes: g.sum?.edgeResponseBytes ?? 0,
      cached_requests: 0,
      cached_bytes: 0,
      encrypted_requests: 0,
      status_1xx: 0, status_2xx: 0, status_3xx: 0, status_4xx: 0, status_5xx: 0,
      ttfb_avg: g.avg?.edgeTimeToFirstByteMs ?? null,
      ttfb_p50: g.quantiles?.edgeTimeToFirstByteMsP50 ?? null,
      ttfb_p95: g.quantiles?.edgeTimeToFirstByteMsP95 ?? null,
      ttfb_p99: g.quantiles?.edgeTimeToFirstByteMsP99 ?? null,
      origin_time_avg: g.avg?.originResponseDurationMs ?? null,
      origin_time_p50: g.quantiles?.originResponseDurationMsP50 ?? null,
      origin_time_p95: g.quantiles?.originResponseDurationMsP95 ?? null,
      origin_time_p99: g.quantiles?.originResponseDurationMsP99 ?? null,
    });
  }

  // Fill cache counts into hourly rows
  for (const g of z1.byCache) {
    const ts = toHourBucket(toEpoch(g.dimensions.datetimeHour));
    const row = hourlyMap.get(ts);
    if (!row) continue;
    const cs = g.dimensions.cacheStatus.toLowerCase();
    if (cs === "hit" || cs === "stale" || cs === "revalidated") {
      row.cached_requests += g.count;
      row.cached_bytes += g.sum.edgeResponseBytes;
    }
  }

  // Fill status counts into hourly rows
  for (const g of z1.byStatus) {
    const ts = toHourBucket(toEpoch(g.dimensions.datetimeHour));
    const row = hourlyMap.get(ts);
    if (!row) continue;
    const code = g.dimensions.edgeResponseStatus;
    if (code < 200) row.status_1xx += g.count;
    else if (code < 300) row.status_2xx += g.count;
    else if (code < 400) row.status_3xx += g.count;
    else if (code < 500) row.status_4xx += g.count;
    else row.status_5xx += g.count;
  }

  const hourly = Array.from(hourlyMap.values());

  // Build dimension rows
  const dims: RawDimRow[] = [];

  // Cache dimension
  for (const g of z1.byCache) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "cache", key: g.dimensions.cacheStatus,
      requests: g.count, bytes: g.sum.edgeResponseBytes,
      ttfb_avg: null, origin_avg: null,
    });
  }

  // Status dimension
  for (const g of z1.byStatus) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "status", key: String(g.dimensions.edgeResponseStatus),
      requests: g.count, bytes: 0, ttfb_avg: null, origin_avg: null,
    });
  }

  // Country dimension
  for (const g of z1.byCountry) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "country", key: g.dimensions.clientCountryName,
      requests: g.count, bytes: g.sum.edgeResponseBytes,
      ttfb_avg: null, origin_avg: null,
    });
  }

  // Path dimension
  for (const g of z2.byPath) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "path", key: g.dimensions.clientRequestPath,
      requests: g.count, bytes: g.sum.edgeResponseBytes,
      ttfb_avg: null, origin_avg: null,
    });
  }

  // Content type dimension
  for (const g of z2.byContentType) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "content_type", key: g.dimensions.edgeResponseContentTypeName,
      requests: g.count, bytes: g.sum.edgeResponseBytes,
      ttfb_avg: g.avg.edgeTimeToFirstByteMs, origin_avg: g.avg.originResponseDurationMs,
    });
  }

  // Method dimension
  for (const g of z2.byMethod) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "method", key: g.dimensions.clientRequestHTTPMethodName,
      requests: g.count, bytes: 0, ttfb_avg: null, origin_avg: null,
    });
  }

  // Origin status dimension
  for (const g of z2.byOriginStatus) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "origin_status", key: String(g.dimensions.originResponseStatus),
      requests: g.count, bytes: 0,
      ttfb_avg: null, origin_avg: g.avg.originResponseDurationMs,
    });
  }

  // Colo dimension
  for (const g of z2.byColo) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "colo", key: g.dimensions.coloCode,
      requests: g.count, bytes: 0,
      ttfb_avg: g.avg.edgeTimeToFirstByteMs, origin_avg: null,
    });
  }

  // SSL protocol dimension
  for (const g of z2.bySSLProto) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "ssl_proto", key: g.dimensions.clientSSLProtocol ?? "none",
      requests: g.count, bytes: 0, ttfb_avg: null, origin_avg: null,
    });
  }

  // HTTP protocol dimension
  for (const g of z2.byHttpProto) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "http_proto", key: g.dimensions.clientRequestHTTPProtocol ?? "unknown",
      requests: g.count, bytes: 0, ttfb_avg: null, origin_avg: null,
    });
  }

  // Bot score dimension
  for (const g of z2.byBotScore) {
    const bucket = g.dimensions.botScoreBucketBy10;
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "bot_score", key: `${bucket}-${bucket + 9}`,
      requests: g.count, bytes: 0, ttfb_avg: null, origin_avg: null,
    });
  }

  // Bot decision dimension
  for (const g of z2.byBotDecision) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "bot_decision", key: g.dimensions.botManagementDecision,
      requests: g.count, bytes: 0, ttfb_avg: null, origin_avg: null,
    });
  }

  // Verified bot dimension
  for (const g of z2.byVerifiedBot) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "verified_bot", key: g.dimensions.verifiedBotCategory || "unknown",
      requests: g.count, bytes: 0, ttfb_avg: null, origin_avg: null,
    });
  }

  return { hourly, dims };
}


/**
 * Fetch encryption ratio time series (httpRequestsOverviewAdaptiveGroups).
 */
export async function fetchRawHttpOverview(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<RawHttpOverviewResult> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
        httpRequestsOverviewAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [datetimeHour_ASC]
        ) {
          sum { requests encryptedRequests }
          dimensions { datetimeHour }
        }
      }
    }
  }`;

  interface Group {
    sum: { requests: number; encryptedRequests: number };
    dimensions: { datetimeHour: string };
  }

  const data = await gql<{ viewer: { zones: Array<{ httpRequestsOverviewAdaptiveGroups: Group[] }> } }>(client, query);
  const groups = data.viewer.zones[0]?.httpRequestsOverviewAdaptiveGroups ?? [];

  return {
    hourly: groups.map((g) => ({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      requests: g.sum.requests,
      encrypted_requests: g.sum.encryptedRequests,
    })),
  };
}


/**
 * Fetch raw firewall data: hourly by action + dimensional breakdowns.
 */
export async function fetchRawFirewall(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<RawFwResult> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
        byAction: firewallEventsAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour action }
        }
        bySource: firewallEventsAdaptiveGroups(
          limit: 1000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour source }
        }
        byCountry: firewallEventsAdaptiveGroups(
          limit: 1000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { datetimeHour clientCountryName }
        }
        byIP: firewallEventsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { datetimeHour clientIP }
        }
        byRule: firewallEventsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { datetimeHour ruleId action description }
        }
        byMethod: firewallEventsAdaptiveGroups(
          limit: 200
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour clientRequestHTTPMethodName }
        }
        byPath: firewallEventsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { datetimeHour clientRequestPath }
        }
        byASN: firewallEventsAdaptiveGroups(
          limit: 200
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { datetimeHour clientASNDescription clientAsn }
        }
        byUA: firewallEventsAdaptiveGroups(
          limit: 200
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { datetimeHour userAgent }
        }
        ddosHourly: firewallEventsAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", source_in: ["l7ddos"] }
        ) {
          count
          dimensions { datetimeHour clientRequestPath }
        }
        ratelimitHourly: firewallEventsAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", source_in: ["ratelimit"] }
        ) {
          count
          dimensions { datetimeHour clientRequestHTTPMethodName clientRequestPath }
        }
      }
    }
  }`;

  interface ActionGroup { count: number; dimensions: { datetimeHour: string; action: string } }
  interface SourceGroup { count: number; dimensions: { datetimeHour: string; source: string } }
  interface CountryGroup { count: number; dimensions: { datetimeHour: string; clientCountryName: string } }
  interface IPGroup { count: number; dimensions: { datetimeHour: string; clientIP: string } }
  interface RuleGroup { count: number; dimensions: { datetimeHour: string; ruleId: string; action: string; description: string } }
  interface MethodGroup { count: number; dimensions: { datetimeHour: string; clientRequestHTTPMethodName: string } }
  interface PathGroup { count: number; dimensions: { datetimeHour: string; clientRequestPath: string } }
  interface ASNGroup { count: number; dimensions: { datetimeHour: string; clientASNDescription: string; clientAsn: string } }
  interface UAGroup { count: number; dimensions: { datetimeHour: string; userAgent: string } }
  interface DdosGroup { count: number; dimensions: { datetimeHour: string; clientRequestPath: string } }
  interface RLGroup { count: number; dimensions: { datetimeHour: string; clientRequestHTTPMethodName: string; clientRequestPath: string } }

  type Zone = {
    byAction: ActionGroup[];
    bySource: SourceGroup[];
    byCountry: CountryGroup[];
    byIP: IPGroup[];
    byRule: RuleGroup[];
    byMethod: MethodGroup[];
    byPath: PathGroup[];
    byASN: ASNGroup[];
    byUA: UAGroup[];
    ddosHourly: DdosGroup[];
    ratelimitHourly: RLGroup[];
  };

  const data = await gql<{ viewer: { zones: Zone[] } }>(client, query);
  const z = data.viewer.zones[0] ?? {
    byAction: [], bySource: [], byCountry: [], byIP: [], byRule: [],
    byMethod: [], byPath: [], byASN: [], byUA: [],
    ddosHourly: [], ratelimitHourly: [],
  };

  // Build hourly rows by aggregating action groups
  const hourlyMap = new Map<number, RawFwHourlyRow>();
  for (const g of z.byAction) {
    const ts = toHourBucket(toEpoch(g.dimensions.datetimeHour));
    if (!hourlyMap.has(ts)) {
      hourlyMap.set(ts, {
        ts, total: 0, blocked: 0, challenged: 0, managed_challenged: 0,
        js_challenged: 0, challenge_solved: 0, logged: 0, skipped: 0,
      });
    }
    const row = hourlyMap.get(ts)!;
    row.total += g.count;
    switch (g.dimensions.action) {
      case "block": row.blocked += g.count; break;
      case "challenge": row.challenged += g.count; break;
      case "managed_challenge": row.managed_challenged += g.count; break;
      case "js_challenge": row.js_challenged += g.count; break;
      case "challenge_solved": row.challenge_solved += g.count; break;
      case "log": row.logged += g.count; break;
      case "skip": row.skipped += g.count; break;
    }
  }

  const hourly = Array.from(hourlyMap.values());
  const dims: RawFwDimRow[] = [];

  for (const g of z.bySource) {
    dims.push({ ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)), dim: "source", key: g.dimensions.source, events: g.count, detail: null });
  }
  for (const g of z.byCountry) {
    dims.push({ ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)), dim: "country", key: g.dimensions.clientCountryName, events: g.count, detail: null });
  }
  for (const g of z.byIP) {
    dims.push({ ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)), dim: "ip", key: g.dimensions.clientIP, events: g.count, detail: null });
  }
  for (const g of z.byRule) {
    dims.push({ ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)), dim: "rule", key: g.dimensions.ruleId, events: g.count, detail: `${g.dimensions.action}|${g.dimensions.description}` });
  }
  for (const g of z.byMethod) {
    dims.push({ ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)), dim: "method", key: g.dimensions.clientRequestHTTPMethodName, events: g.count, detail: null });
  }
  for (const g of z.byPath) {
    dims.push({ ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)), dim: "path", key: g.dimensions.clientRequestPath, events: g.count, detail: null });
  }
  for (const g of z.byASN) {
    dims.push({ ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)), dim: "asn", key: g.dimensions.clientAsn, events: g.count, detail: g.dimensions.clientASNDescription });
  }
  for (const g of z.byUA) {
    dims.push({ ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)), dim: "ua", key: g.dimensions.userAgent, events: g.count, detail: null });
  }
  for (const g of z.ddosHourly) {
    dims.push({ ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)), dim: "l7ddos", key: g.dimensions.clientRequestPath || "*", events: g.count, detail: null });
  }
  for (const g of z.ratelimitHourly) {
    dims.push({ ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)), dim: "ratelimit", key: `${g.dimensions.clientRequestHTTPMethodName} ${g.dimensions.clientRequestPath}`, events: g.count, detail: null });
  }

  return { hourly, dims };
}


/**
 * Fetch raw DNS analytics data.
 */
export async function fetchRawDns(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<RawDnsResult> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
        byHour: dnsAnalyticsAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          dimensions { datetimeHour }
        }
        byQueryType: dnsAnalyticsAdaptiveGroups(
          limit: 1000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour queryType }
        }
        byResponseCode: dnsAnalyticsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour responseCode }
        }
        byQueryName: dnsAnalyticsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { datetimeHour queryName }
        }
      }
    }
  }`;

  interface HourGroup { count: number; dimensions: { datetimeHour: string } }
  interface TypeGroup { count: number; dimensions: { datetimeHour: string; queryType: string } }
  interface CodeGroup { count: number; dimensions: { datetimeHour: string; responseCode: string } }
  interface NameGroup { count: number; dimensions: { datetimeHour: string; queryName: string } }

  type Zone = {
    byHour: HourGroup[];
    byQueryType: TypeGroup[];
    byResponseCode: CodeGroup[];
    byQueryName: NameGroup[];
  };

  const data = await gql<{ viewer: { zones: Zone[] } }>(client, query);
  const z = data.viewer.zones[0] ?? { byHour: [], byQueryType: [], byResponseCode: [], byQueryName: [] };

  const hourly: RawDnsHourlyRow[] = z.byHour.map((g) => ({
    ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
    queries: g.count,
  }));

  const dims: RawDnsDimRow[] = [];

  for (const g of z.byQueryType) {
    dims.push({ ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)), dim: "query_type", key: g.dimensions.queryType, queries: g.count });
  }
  for (const g of z.byResponseCode) {
    dims.push({ ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)), dim: "response_code", key: g.dimensions.responseCode, queries: g.count });
  }
  for (const g of z.byQueryName) {
    dims.push({ ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)), dim: "query_name", key: g.dimensions.queryName, queries: g.count });
  }

  return { hourly, dims };
}


/**
 * Fetch raw health check events.
 */
export async function fetchRawHealthEvents(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<RawHealthResult> {
  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneId}" }) {
        healthCheckEventsAdaptive(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [datetime_ASC]
        ) {
          datetime
          healthCheckName
          healthStatus
          originIP
          originResponseHTTPStatusCode
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
    originResponseHTTPStatusCode: number;
    rttMs: number;
    failureReason: string;
    region: string;
  }

  const data = await gql<{ viewer: { zones: Array<{ healthCheckEventsAdaptive: Event[] }> } }>(client, query);
  const events = data.viewer.zones[0]?.healthCheckEventsAdaptive ?? [];

  return {
    events: events.map((e) => ({
      ts: toHourBucket(toEpoch(e.datetime)),
      name: e.healthCheckName,
      origin_ip: e.originIP || "",
      status: e.healthStatus,
      response_status: e.originResponseHTTPStatusCode || null,
      rtt_ms: e.rttMs || null,
      failure_reason: e.failureReason || null,
      region: e.region || null,
    })),
  };
}


// =============================================================================
// Account fetchers
// =============================================================================

/**
 * Fetch raw Gateway DNS data.
 */
export async function fetchRawGwDns(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<RawGwDnsResult> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        byHour: gatewayResolverQueriesAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour resolverDecision }
        }
        byDomain: gatewayResolverQueriesAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", resolverDecision: "9" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { datetimeHour queryName }
        }
        byPolicy: gatewayResolverQueriesAdaptiveGroups(
          limit: 200
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour policyName resolverDecision }
        }
        byLocation: gatewayResolverQueriesAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour locationName resolverDecision }
        }
        byCategory: gatewayResolverByCategoryAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour categoryId resolverDecision }
        }
      }
    }
  }`;

  interface HourGroup { count: number; dimensions: { datetimeHour: string; resolverDecision: string } }
  interface DomainGroup { count: number; dimensions: { datetimeHour: string; queryName: string } }
  interface PolicyGroup { count: number; dimensions: { datetimeHour: string; policyName: string; resolverDecision: string } }
  interface LocationGroup { count: number; dimensions: { datetimeHour: string; locationName: string; resolverDecision: string } }
  interface CategoryGroup { count: number; dimensions: { datetimeHour: string; categoryId: string; resolverDecision: string } }

  type Acct = {
    byHour: HourGroup[];
    byDomain: DomainGroup[];
    byPolicy: PolicyGroup[];
    byLocation: LocationGroup[];
    byCategory: CategoryGroup[];
  };

  const data = await gql<{ viewer: { accounts: Acct[] } }>(client, query);
  const a = data.viewer.accounts[0] ?? { byHour: [], byDomain: [], byPolicy: [], byLocation: [], byCategory: [] };

  // Aggregate hourly totals from byHour (which includes resolverDecision)
  const BLOCKED_DECISIONS = new Set(["2", "3", "4", "5", "6", "7", "9", "15", "16"]);
  const hourlyMap = new Map<number, RawGwDnsHourlyRow>();

  for (const g of a.byHour) {
    const ts = toHourBucket(toEpoch(g.dimensions.datetimeHour));
    if (!hourlyMap.has(ts)) hourlyMap.set(ts, { ts, total: 0, blocked: 0, allowed: 0 });
    const row = hourlyMap.get(ts)!;
    row.total += g.count;
    if (BLOCKED_DECISIONS.has(g.dimensions.resolverDecision)) {
      row.blocked += g.count;
    } else {
      row.allowed += g.count;
    }
  }

  const hourly = Array.from(hourlyMap.values());
  const dims: RawGwDnsDimRow[] = [];

  // Decision dimension
  for (const g of a.byHour) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "decision", key: g.dimensions.resolverDecision,
      queries: g.count, detail: null,
    });
  }

  // Blocked domain dimension
  for (const g of a.byDomain) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "blocked_domain", key: g.dimensions.queryName,
      queries: g.count, detail: null,
    });
  }

  // Policy dimension
  for (const g of a.byPolicy) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "policy", key: g.dimensions.policyName || "Default",
      queries: g.count, detail: g.dimensions.resolverDecision,
    });
  }

  // Location dimension
  for (const g of a.byLocation) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "location", key: g.dimensions.locationName || "Unknown",
      queries: g.count, detail: g.dimensions.resolverDecision,
    });
  }

  // Category dimension
  for (const g of a.byCategory) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "category", key: g.dimensions.categoryId,
      queries: g.count, detail: g.dimensions.resolverDecision,
    });
  }

  return { hourly, dims };
}


/**
 * Fetch raw Gateway Network data.
 */
export async function fetchRawGwNet(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<RawGwNetResult> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        byHour: gatewayL4SessionsAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour action }
        }
        byDestIP: gatewayL4SessionsAdaptiveGroups(
          limit: 200
          filter: { datetime_geq: "${since}", datetime_lt: "${until}", action: "block" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { datetimeHour destinationIp dstIpCountry destinationPort transport }
        }
        bySrcCountry: gatewayL4SessionsAdaptiveGroups(
          limit: 200
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { datetimeHour srcIpCountry }
        }
        byTransport: gatewayL4SessionsAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour transport }
        }
        byPort: gatewayL4SessionsAdaptiveGroups(
          limit: 200
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { datetimeHour destinationPort }
        }
      }
    }
  }`;

  interface ActionGroup { count: number; dimensions: { datetimeHour: string; action: string } }
  interface DestGroup { count: number; dimensions: { datetimeHour: string; destinationIp: string; dstIpCountry: string; destinationPort: number; transport: string } }
  interface CountryGroup { count: number; dimensions: { datetimeHour: string; srcIpCountry: string } }
  interface TransportGroup { count: number; dimensions: { datetimeHour: string; transport: string } }
  interface PortGroup { count: number; dimensions: { datetimeHour: string; destinationPort: number } }

  type Acct = {
    byHour: ActionGroup[];
    byDestIP: DestGroup[];
    bySrcCountry: CountryGroup[];
    byTransport: TransportGroup[];
    byPort: PortGroup[];
  };

  const data = await gql<{ viewer: { accounts: Acct[] } }>(client, query);
  const a = data.viewer.accounts[0] ?? { byHour: [], byDestIP: [], bySrcCountry: [], byTransport: [], byPort: [] };

  const hourlyMap = new Map<number, RawGwNetHourlyRow>();
  for (const g of a.byHour) {
    const ts = toHourBucket(toEpoch(g.dimensions.datetimeHour));
    if (!hourlyMap.has(ts)) hourlyMap.set(ts, { ts, allowed: 0, blocked: 0 });
    const row = hourlyMap.get(ts)!;
    if (g.dimensions.action === "block") row.blocked += g.count;
    else row.allowed += g.count;
  }

  const hourly = Array.from(hourlyMap.values());
  const dims: RawGwNetDimRow[] = [];

  for (const g of a.byDestIP) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "blocked_dest", key: g.dimensions.destinationIp,
      sessions: g.count,
      detail: `country:${g.dimensions.dstIpCountry},port:${g.dimensions.destinationPort},proto:${g.dimensions.transport}`,
    });
  }
  for (const g of a.bySrcCountry) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "src_country", key: g.dimensions.srcIpCountry,
      sessions: g.count, detail: null,
    });
  }
  for (const g of a.byTransport) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "transport", key: g.dimensions.transport,
      sessions: g.count, detail: null,
    });
  }
  for (const g of a.byPort) {
    dims.push({
      ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
      dim: "port", key: String(g.dimensions.destinationPort),
      sessions: g.count, detail: null,
    });
  }

  return { hourly, dims };
}


/**
 * Fetch raw Gateway HTTP data.
 */
export async function fetchRawGwHttp(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<RawGwHttpResult> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        byHour: gatewayL7RequestsAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [datetimeHour_ASC]
        ) {
          count
          dimensions { datetimeHour }
        }
        byAction: gatewayL7RequestsAdaptiveGroups(
          limit: 200
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { datetimeHour action }
        }
        byHost: gatewayL7RequestsAdaptiveGroups(
          limit: 200
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { datetimeHour host }
        }
      }
    }
  }`;

  interface HourGroup { count: number; dimensions: { datetimeHour: string } }
  interface ActionGroup { count: number; dimensions: { datetimeHour: string; action: string } }
  interface HostGroup { count: number; dimensions: { datetimeHour: string; host: string } }

  type Acct = { byHour: HourGroup[]; byAction: ActionGroup[]; byHost: HostGroup[] };

  const data = await gql<{ viewer: { accounts: Acct[] } }>(client, query);
  const a = data.viewer.accounts[0] ?? { byHour: [], byAction: [], byHost: [] };

  const hourly: RawGwHttpHourlyRow[] = a.byHour.map((g) => ({
    ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)),
    total: g.count,
  }));

  const dims: RawGwHttpDimRow[] = [];
  for (const g of a.byAction) {
    dims.push({ ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)), dim: "action", key: g.dimensions.action, requests: g.count });
  }
  for (const g of a.byHost) {
    dims.push({ ts: toHourBucket(toEpoch(g.dimensions.datetimeHour)), dim: "host", key: g.dimensions.host, requests: g.count });
  }

  return { hourly, dims };
}


/**
 * Fetch raw Access login data.
 */
export async function fetchRawAccess(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<RawAccessResult> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        byDay: accessLoginRequestsAdaptiveGroups(
          limit: 5000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { date isSuccessfulLogin }
        }
        byApp: accessLoginRequestsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { date appId isSuccessfulLogin }
        }
        byCountry: accessLoginRequestsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
          orderBy: [count_DESC]
        ) {
          count
          dimensions { date country }
        }
        byIdp: accessLoginRequestsAdaptiveGroups(
          limit: 200
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { date identityProvider }
        }
        byUser: accessLoginRequestsAdaptiveGroups(
          limit: 500
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          count
          dimensions { date userUuid }
        }
      }
    }
  }`;

  interface DayGroup { count: number; dimensions: { date: string; isSuccessfulLogin: string } }
  interface AppGroup { count: number; dimensions: { date: string; appId: string; isSuccessfulLogin: string } }
  interface CountryGroup { count: number; dimensions: { date: string; country: string } }
  interface IdpGroup { count: number; dimensions: { date: string; identityProvider: string } }
  interface UserGroup { count: number; dimensions: { date: string; userUuid: string } }

  type Acct = {
    byDay: DayGroup[];
    byApp: AppGroup[];
    byCountry: CountryGroup[];
    byIdp: IdpGroup[];
    byUser: UserGroup[];
  };

  const data = await gql<{ viewer: { accounts: Acct[] } }>(client, query);
  const a = data.viewer.accounts[0] ?? { byDay: [], byApp: [], byCountry: [], byIdp: [], byUser: [] };

  // Daily aggregation
  const dailyMap = new Map<number, RawAccessDailyRow>();
  for (const g of a.byDay) {
    const ts = toDayBucket(g.dimensions.date);
    if (!dailyMap.has(ts)) dailyMap.set(ts, { ts, successful: 0, failed: 0 });
    const row = dailyMap.get(ts)!;
    if (g.dimensions.isSuccessfulLogin === "1") row.successful += g.count;
    else row.failed += g.count;
  }

  const daily = Array.from(dailyMap.values());
  const dims: RawAccessDimRow[] = [];

  for (const g of a.byApp) {
    dims.push({
      ts: toDayBucket(g.dimensions.date),
      dim: "app", key: g.dimensions.appId,
      logins: g.count, detail: g.dimensions.isSuccessfulLogin,
    });
  }
  for (const g of a.byCountry) {
    dims.push({
      ts: toDayBucket(g.dimensions.date),
      dim: "country", key: g.dimensions.country,
      logins: g.count, detail: null,
    });
  }
  for (const g of a.byIdp) {
    dims.push({
      ts: toDayBucket(g.dimensions.date),
      dim: "idp", key: g.dimensions.identityProvider,
      logins: g.count, detail: null,
    });
  }
  for (const g of a.byUser) {
    dims.push({
      ts: toDayBucket(g.dimensions.date),
      dim: "user", key: g.dimensions.userUuid,
      logins: g.count, detail: null,
    });
  }

  return { daily, dims };
}


/**
 * Fetch raw DDoS attack analytics (account-scoped L3/L4).
 */
export async function fetchRawDosd(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<RawDosdResult> {
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        dosdAttackAnalyticsGroups(
          limit: 1000
          filter: { datetime_geq: "${since}", datetime_lt: "${until}" }
        ) {
          dimensions {
            attackId
            attackType
            attackVector
            ipProtocolName
            destinationPort
            mitigationType
          }
          sum {
            packets
            bits
            droppedPackets
            droppedBits
          }
          min { datetimeFiveMinutes }
          max { datetimeFiveMinutes }
        }
      }
    }
  }`;

  interface Group {
    dimensions: {
      attackId: string;
      attackType: string;
      attackVector: string;
      ipProtocolName: string;
      destinationPort: number;
      mitigationType: string;
    };
    sum: { packets: number; bits: number; droppedPackets: number; droppedBits: number };
    min: { datetimeFiveMinutes: string };
    max: { datetimeFiveMinutes: string };
  }

  const data = await gql<{ viewer: { accounts: Array<{ dosdAttackAnalyticsGroups: Group[] }> } }>(client, query);
  const groups = data.viewer.accounts[0]?.dosdAttackAnalyticsGroups ?? [];

  return {
    attacks: groups.map((g) => ({
      attack_id: g.dimensions.attackId,
      attack_type: g.dimensions.attackType || null,
      attack_vector: g.dimensions.attackVector || null,
      ip_protocol: g.dimensions.ipProtocolName || null,
      destination_port: g.dimensions.destinationPort || null,
      mitigation_type: g.dimensions.mitigationType || null,
      packets: g.sum.packets,
      bits: g.sum.bits,
      dropped_packets: g.sum.droppedPackets,
      dropped_bits: g.sum.droppedBits,
      start_time: g.min.datetimeFiveMinutes ? toEpoch(g.min.datetimeFiveMinutes) : null,
      end_time: g.max.datetimeFiveMinutes ? toEpoch(g.max.datetimeFiveMinutes) : null,
    })),
  };
}


// =============================================================================
// Composite fetcher functions
// =============================================================================

/**
 * Fetch all raw zone data in parallel.
 * Returns null for each dataset that fails with permission error.
 */
export async function fetchAllZoneData(
  client: CloudflareClient,
  zoneId: string,
  since: string,
  until: string,
): Promise<RawZoneData> {
  const [http, httpOverview, firewall, dns, health] = await Promise.allSettled([
    fetchRawHttp(client, zoneId, since, until),
    fetchRawHttpOverview(client, zoneId, since, until),
    fetchRawFirewall(client, zoneId, since, until),
    fetchRawDns(client, zoneId, since, until),
    fetchRawHealthEvents(client, zoneId, since, until),
  ]);

  return {
    http: http.status === "fulfilled" ? http.value : null,
    httpOverview: httpOverview.status === "fulfilled" ? httpOverview.value : null,
    firewall: firewall.status === "fulfilled" ? firewall.value : null,
    dns: dns.status === "fulfilled" ? dns.value : null,
    health: health.status === "fulfilled" ? health.value : null,
  };
}

/**
 * Fetch all raw account data in parallel.
 * Returns null for each dataset that fails with permission error.
 */
export async function fetchAllAccountData(
  client: CloudflareClient,
  accountId: string,
  since: string,
  until: string,
): Promise<RawAccountData> {
  const [gwDns, gwNet, gwHttp, access, dosd] = await Promise.allSettled([
    fetchRawGwDns(client, accountId, since, until),
    fetchRawGwNet(client, accountId, since, until),
    fetchRawGwHttp(client, accountId, since, until),
    fetchRawAccess(client, accountId, since, until),
    fetchRawDosd(client, accountId, since, until),
  ]);

  return {
    gwDns: gwDns.status === "fulfilled" ? gwDns.value : null,
    gwNet: gwNet.status === "fulfilled" ? gwNet.value : null,
    gwHttp: gwHttp.status === "fulfilled" ? gwHttp.value : null,
    access: access.status === "fulfilled" ? access.value : null,
    dosd: dosd.status === "fulfilled" ? dosd.value : null,
  };
}
