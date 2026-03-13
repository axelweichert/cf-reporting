/**
 * Extension dataset registry – definitions for 35 additional CF GraphQL datasets.
 *
 * Each definition tells the generic fetcher how to build the GQL query,
 * parse the response, and store into the EAV tables (raw_ext_ts / raw_ext_dim).
 *
 * Adding a new dataset = adding a registry entry here. No migration needed.
 *
 * NOTE: Not all CF *Groups datasets expose a top-level `count` field.
 * Datasets without `count` rely on sum/max/avg metrics only.
 * The fetcher checks `hasCount` to decide whether to include count in GQL.
 */

// =============================================================================
// Types
// =============================================================================

export interface ExtMetricDef {
  /** Metric name stored in raw_ext_ts.metric, e.g. "count", "sum.requests" */
  name: string;
  /** GQL path: "count" | "sum.fieldName" | "avg.fieldName" | "max.fieldName" */
  path: string;
}

export interface ExtDimensionDef {
  /** GQL alias for this breakdown query, e.g. "by_script" */
  alias: string;
  /** Dimension field name in GQL, e.g. "scriptName" */
  field: string;
  /** Name stored in raw_ext_dim.dim, e.g. "scriptName" */
  dimName: string;
  /** Top-N limit for this breakdown */
  limit: number;
}

export interface ExtDatasetDef {
  /** GraphQL node name, e.g. "workersInvocationsAdaptive" */
  gqlNode: string;
  /** Collection log key, e.g. "ext:workers" */
  key: string;
  /** Scope type */
  scope: "zone" | "account";
  /** GQL parent node */
  parentNode: "zones" | "accounts";
  /** GQL scope filter field */
  scopeFilter: "zoneTag" | "accountTag";
  /** Time dimension field in GQL dimensions block */
  timeDim: string;
  /** How to bucket the timestamp for storage */
  timeBucket: "hour" | "day";
  /** Row limit for the main time series query */
  limit: number;
  /** Whether the dataset has a top-level count field */
  hasCount: boolean;
  /** Metrics to extract from each row (count excluded if !hasCount) */
  metrics: ExtMetricDef[];
  /** Optional dimension breakdowns */
  dimensions: ExtDimensionDef[];
}

// =============================================================================
// Helpers
// =============================================================================

function zoneDef(
  gqlNode: string,
  key: string,
  opts: Partial<Pick<ExtDatasetDef, "timeDim" | "timeBucket" | "limit" | "hasCount">> & {
    metrics: ExtMetricDef[];
    dimensions?: ExtDimensionDef[];
  },
): ExtDatasetDef {
  return {
    gqlNode,
    key,
    scope: "zone",
    parentNode: "zones",
    scopeFilter: "zoneTag",
    timeDim: opts.timeDim ?? "datetimeHour",
    timeBucket: opts.timeBucket ?? "hour",
    limit: opts.limit ?? 10000,
    hasCount: opts.hasCount ?? true,
    metrics: opts.metrics,
    dimensions: opts.dimensions ?? [],
  };
}

function accountDef(
  gqlNode: string,
  key: string,
  opts: Partial<Pick<ExtDatasetDef, "timeDim" | "timeBucket" | "limit" | "hasCount">> & {
    metrics: ExtMetricDef[];
    dimensions?: ExtDimensionDef[];
  },
): ExtDatasetDef {
  return {
    gqlNode,
    key,
    scope: "account",
    parentNode: "accounts",
    scopeFilter: "accountTag",
    timeDim: opts.timeDim ?? "datetimeHour",
    timeBucket: opts.timeBucket ?? "hour",
    limit: opts.limit ?? 10000,
    hasCount: opts.hasCount ?? true,
    metrics: opts.metrics,
    dimensions: opts.dimensions ?? [],
  };
}

/** Shorthand for a count metric (only used when hasCount is true) */
const COUNT: ExtMetricDef = { name: "count", path: "count" };

/** Build sum metric defs from field names */
function sumMetrics(...fields: string[]): ExtMetricDef[] {
  return fields.map((f) => ({ name: `sum.${f}`, path: `sum.${f}` }));
}

/** Build avg metric defs from field names */
function avgMetrics(...fields: string[]): ExtMetricDef[] {
  return fields.map((f) => ({ name: `avg.${f}`, path: `avg.${f}` }));
}

/** Build max metric defs from field names */
function maxMetrics(...fields: string[]): ExtMetricDef[] {
  return fields.map((f) => ({ name: `max.${f}`, path: `max.${f}` }));
}

/** Build a dimension def */
function dim(field: string, limit = 50): ExtDimensionDef {
  return { alias: `by_${field}`, field, dimName: field, limit };
}

// =============================================================================
// Zone-scoped datasets (11)
// =============================================================================

export const EXT_ZONE_DATASETS: ExtDatasetDef[] = [
  // 1. Load Balancing – has count
  zoneDef("loadBalancingRequestsAdaptiveGroups", "ext:lb", {
    metrics: [COUNT],
    dimensions: [dim("lbName"), dim("region")],
  }),

  // 2. Cache Reserve – has count + sum
  zoneDef("cacheReserveRequestsAdaptiveGroups", "ext:cache-reserve", {
    metrics: [COUNT, ...sumMetrics("edgeResponseBytes")],
    dimensions: [dim("cacheStatus")],
  }),

  // 3. Waiting Room – NO count (has sum, avg, max, min)
  zoneDef("waitingRoomAnalyticsAdaptiveGroups", "ext:waiting-room", {
    hasCount: false,
    metrics: [...sumMetrics("newUsersPerMinute", "sessionsRevoked")],
    dimensions: [dim("waitingRoomId")],
  }),

  // 4. NEL Reports – has count
  zoneDef("nelReportsAdaptiveGroups", "ext:nel", {
    metrics: [COUNT],
    dimensions: [dim("type"), dim("phase")],
  }),

  // 5. Email Routing – has count
  zoneDef("emailRoutingAdaptiveGroups", "ext:email-routing", {
    metrics: [COUNT],
    dimensions: [dim("action"), dim("status")],
  }),

  // 6. Workers (zone-scoped) – NO count (has sum, avg)
  zoneDef("workersZoneInvocationsAdaptiveGroups", "ext:workers-zone", {
    hasCount: false,
    metrics: [...sumMetrics("requests", "responseBodySize", "subrequests", "totalCpuTime")],
    dimensions: [dim("status")],
  }),

  // 7. Page Shield – has count
  zoneDef("pageShieldReportsAdaptiveGroups", "ext:page-shield", {
    metrics: [COUNT],
    dimensions: [dim("action"), dim("resourceType")],
  }),

  // 8. Image Resizing – has count + sum
  zoneDef("imageResizingRequests1mGroups", "ext:image-resizing", {
    metrics: [COUNT, ...sumMetrics("requests", "originalBytes", "resizedBytes")],
    dimensions: [dim("contentType")],
  }),

  // 9. Logpush Health (zone-scoped) – has count + sum
  zoneDef("logpushHealthAdaptiveGroups", "ext:logpush-health", {
    metrics: [COUNT, ...sumMetrics("bytes", "bytesCompressed", "records", "uploads")],
    dimensions: [dim("destinationType"), dim("status")],
  }),

  // 10. DMARC Reports – NO count (has sum, avg, uniq)
  zoneDef("dmarcReportsSourcesAdaptiveGroups", "ext:dmarc", {
    hasCount: false,
    metrics: [...sumMetrics("totalMatchingMessages", "dkimPass", "spfPass", "dmarc")],
    dimensions: [dim("disposition")],
  }),

  // 11. User Profiles – NO count (has sum, uniq)
  zoneDef("userProfilesAdaptiveGroups", "ext:user-profiles", {
    hasCount: false,
    timeDim: "date",
    timeBucket: "day",
    metrics: [],  // topCountries is not a scalar – skip
    dimensions: [],
  }),
];

// =============================================================================
// Account-scoped datasets (24)
// =============================================================================

export const EXT_ACCOUNT_DATASETS: ExtDatasetDef[] = [
  // 1. Workers Invocations – NO count (has sum, avg, max, min, quantiles)
  accountDef("workersInvocationsAdaptive", "ext:workers", {
    hasCount: false,
    metrics: [
      ...sumMetrics("requests", "errors", "cpuTimeUs", "duration", "wallTime", "subrequests", "responseBodySize"),
    ],
    dimensions: [dim("scriptName"), dim("status")],
  }),

  // 2. Workers Overview – has count + sum
  accountDef("workersOverviewRequestsAdaptiveGroups", "ext:workers-overview", {
    timeDim: "datetime",
    metrics: [COUNT, ...sumMetrics("cpuTimeUs")],
    dimensions: [dim("status")],
  }),

  // 3. Workers Subrequests – NO count (has sum, quantiles)
  accountDef("workersSubrequestsAdaptiveGroups", "ext:workers-subreq", {
    hasCount: false,
    metrics: [...sumMetrics("subrequests", "responseBodySize", "requestBodySize")],
    dimensions: [dim("scriptName"), dim("cacheStatus")],
  }),

  // 4. R2 Operations – NO count (has sum)
  accountDef("r2OperationsAdaptiveGroups", "ext:r2-ops", {
    hasCount: false,
    metrics: [...sumMetrics("requests", "responseBytes", "responseObjectSize")],
    dimensions: [dim("actionType"), dim("bucketName")],
  }),

  // 5. R2 Storage – NO count (has max)
  accountDef("r2StorageAdaptiveGroups", "ext:r2-storage", {
    hasCount: false,
    metrics: [...maxMetrics("objectCount", "payloadSize", "metadataSize", "uploadCount")],
    dimensions: [dim("bucketName")],
  }),

  // 6. D1 Analytics – has count + sum
  accountDef("d1AnalyticsAdaptiveGroups", "ext:d1", {
    metrics: [
      COUNT,
      ...sumMetrics("readQueries", "writeQueries", "rowsRead", "rowsWritten", "queryBatchResponseBytes"),
    ],
    dimensions: [dim("databaseId")],
  }),

  // 7. Durable Objects Invocations – NO count (has sum, max, min, quantiles)
  accountDef("durableObjectsInvocationsAdaptiveGroups", "ext:do-invocations", {
    hasCount: false,
    metrics: [...sumMetrics("requests", "errors", "responseBodySize", "wallTime")],
    dimensions: [dim("scriptName"), dim("status")],
  }),

  // 8. Durable Objects Storage – NO count (has max)
  accountDef("durableObjectsStorageGroups", "ext:do-storage", {
    hasCount: false,
    metrics: [...maxMetrics("storedBytes")],
    dimensions: [],
  }),

  // 9. KV Operations – has count + sum
  accountDef("kvOperationsAdaptiveGroups", "ext:kv-ops", {
    metrics: [COUNT, ...sumMetrics("requests", "objectBytes")],
    dimensions: [dim("actionType"), dim("namespaceId")],
  }),

  // 10. KV Storage – NO count (has max)
  accountDef("kvStorageAdaptiveGroups", "ext:kv-storage", {
    hasCount: false,
    metrics: [...maxMetrics("byteCount", "keyCount")],
    dimensions: [dim("namespaceId")],
  }),

  // 11. Images – NO count (has sum)
  accountDef("imagesRequestsAdaptiveGroups", "ext:images", {
    hasCount: false,
    metrics: [...sumMetrics("requests")],
    dimensions: [],
  }),

  // 12. Stream – has count + sum
  accountDef("streamMinutesViewedAdaptiveGroups", "ext:stream", {
    metrics: [COUNT, ...sumMetrics("minutesViewed")],
    dimensions: [],
  }),

  // 13. Pages Functions – NO count (has sum, quantiles)
  accountDef("pagesFunctionsInvocationsAdaptiveGroups", "ext:pages-functions", {
    hasCount: false,
    metrics: [...sumMetrics("requests", "errors", "duration", "wallTime", "subrequests")],
    dimensions: [dim("scriptName"), dim("status")],
  }),

  // 14. Spectrum – NO count (has sum, avg)
  accountDef("spectrumNetworkAnalyticsAdaptiveGroups", "ext:spectrum", {
    hasCount: false,
    metrics: [...sumMetrics("bits", "packets")],
    dimensions: [dim("direction"), dim("ipProtocolName")],
  }),

  // 15. CDN Network Analytics – NO count (has sum, avg)
  accountDef("cdnNetworkAnalyticsAdaptiveGroups", "ext:cdn-net", {
    hasCount: false,
    metrics: [...sumMetrics("bits", "packets")],
    dimensions: [dim("direction"), dim("outcome")],
  }),

  // 16. Magic Transit – NO count (has sum, avg)
  accountDef("magicTransitNetworkAnalyticsAdaptiveGroups", "ext:magic-transit", {
    hasCount: false,
    metrics: [...sumMetrics("bits", "packets")],
    dimensions: [dim("direction"), dim("outcome")],
  }),

  // 17. Turnstile – has count
  accountDef("turnstileAdaptiveGroups", "ext:turnstile", {
    metrics: [COUNT],
    dimensions: [dim("siteKey"), dim("action")],
  }),

  // 18. Browser Isolation – has count
  accountDef("browserIsolationSessionsAdaptiveGroups", "ext:browser-isolation", {
    timeDim: "datetime",
    metrics: [COUNT],
    dimensions: [],
  }),

  // 19. RUM Pageload – has count + sum
  accountDef("rumPageloadEventsAdaptiveGroups", "ext:rum-pageload", {
    metrics: [COUNT, ...sumMetrics("visits")],
    dimensions: [dim("requestHost"), dim("countryName")],
  }),

  // 20. RUM Performance – has count + sum + avg
  accountDef("rumPerformanceEventsAdaptiveGroups", "ext:rum-perf", {
    metrics: [
      COUNT,
      ...sumMetrics("visits"),
      ...avgMetrics("pageLoadTime", "firstContentfulPaint", "requestTime", "responseTime"),
    ],
    dimensions: [dim("requestHost")],
  }),

  // 21. RUM Web Vitals – has count + sum + avg
  accountDef("rumWebVitalsEventsAdaptiveGroups", "ext:rum-vitals", {
    metrics: [
      COUNT,
      ...sumMetrics("visits", "lcpGood", "lcpPoor", "lcpTotal", "clsGood", "clsPoor", "clsTotal", "inpGood", "inpPoor", "inpTotal"),
      ...avgMetrics("largestContentfulPaint", "cumulativeLayoutShift", "interactionToNextPaint", "firstContentfulPaint", "timeToFirstByte"),
    ],
    dimensions: [dim("requestHost")],
  }),

  // 22. AI Gateway – has count + sum
  accountDef("aiGatewayRequestsAdaptiveGroups", "ext:ai-gateway", {
    metrics: [
      COUNT,
      ...sumMetrics("cachedRequests", "erroredRequests", "cost", "cachedTokensIn", "cachedTokensOut", "uncachedTokensIn", "uncachedTokensOut"),
    ],
    dimensions: [dim("model"), dim("provider")],
  }),

  // 23. Cloudflare Tunnels – NO count (has sum, avg)
  accountDef("cloudflareTunnelsAnalyticsAdaptiveGroups", "ext:tunnels", {
    hasCount: false,
    metrics: [...sumMetrics("bits", "egressBits")],
    dimensions: [dim("protocol")],
  }),

  // 24. WARP Devices – has count
  accountDef("warpDeviceAdaptiveGroups", "ext:warp", {
    metrics: [COUNT],
    dimensions: [dim("clientPlatform"), dim("status")],
  }),
];

/** All extension dataset keys (for logging / status) */
export const ALL_EXT_KEYS = [
  ...EXT_ZONE_DATASETS.map((d) => d.key),
  ...EXT_ACCOUNT_DATASETS.map((d) => d.key),
];
