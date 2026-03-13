/**
 * Extension dataset registry – definitions for ALL additional CF GraphQL datasets.
 *
 * Each definition tells the generic fetcher how to build the GQL query,
 * parse the response, and store into the EAV tables (raw_ext_ts / raw_ext_dim).
 *
 * Adding a new dataset = adding a registry entry here. No migration needed.
 *
 * NOTE: Not all CF *Groups datasets expose a top-level `count` field.
 * Datasets without `count` rely on sum/max/avg metrics only.
 * The fetcher checks `hasCount` to decide whether to include count in GQL.
 *
 * Generated from GQL introspection on 2026-03-13. 28 zone + 122 account = 150 total.
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
    gqlNode, key, scope: "zone", parentNode: "zones", scopeFilter: "zoneTag",
    timeDim: opts.timeDim ?? "datetimeHour", timeBucket: opts.timeBucket ?? "hour",
    limit: opts.limit ?? 10000, hasCount: opts.hasCount ?? true,
    metrics: opts.metrics, dimensions: opts.dimensions ?? [],
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
    gqlNode, key, scope: "account", parentNode: "accounts", scopeFilter: "accountTag",
    timeDim: opts.timeDim ?? "datetimeHour", timeBucket: opts.timeBucket ?? "hour",
    limit: opts.limit ?? 10000, hasCount: opts.hasCount ?? true,
    metrics: opts.metrics, dimensions: opts.dimensions ?? [],
  };
}

const COUNT: ExtMetricDef = { name: "count", path: "count" };
function sumMetrics(...fields: string[]): ExtMetricDef[] {
  return fields.map((f) => ({ name: `sum.${f}`, path: `sum.${f}` }));
}
function avgMetrics(...fields: string[]): ExtMetricDef[] {
  return fields.map((f) => ({ name: `avg.${f}`, path: `avg.${f}` }));
}
function maxMetrics(...fields: string[]): ExtMetricDef[] {
  return fields.map((f) => ({ name: `max.${f}`, path: `max.${f}` }));
}
function dim(field: string, limit = 50): ExtDimensionDef {
  return { alias: `by_${field}`, field, dimName: field, limit };
}

// =============================================================================
// Zone-scoped datasets (28)
// =============================================================================

export const EXT_ZONE_DATASETS: ExtDatasetDef[] = [
  // --- Original 11 ---
  zoneDef("loadBalancingRequestsAdaptiveGroups", "ext:lb", {
    metrics: [COUNT], dimensions: [dim("lbName"), dim("region")],
  }),
  zoneDef("cacheReserveRequestsAdaptiveGroups", "ext:cache-reserve", {
    metrics: [COUNT, ...sumMetrics("edgeResponseBytes")], dimensions: [dim("cacheStatus")],
  }),
  zoneDef("waitingRoomAnalyticsAdaptiveGroups", "ext:waiting-room", {
    hasCount: false, metrics: [...sumMetrics("newUsersPerMinute", "sessionsRevoked")], dimensions: [dim("waitingRoomId")],
  }),
  zoneDef("nelReportsAdaptiveGroups", "ext:nel", {
    metrics: [COUNT], dimensions: [dim("type"), dim("phase")],
  }),
  zoneDef("emailRoutingAdaptiveGroups", "ext:email-routing", {
    metrics: [COUNT], dimensions: [dim("action"), dim("status")],
  }),
  zoneDef("workersZoneInvocationsAdaptiveGroups", "ext:workers-zone", {
    hasCount: false, metrics: [...sumMetrics("requests", "responseBodySize", "subrequests", "totalCpuTime")], dimensions: [dim("status")],
  }),
  zoneDef("pageShieldReportsAdaptiveGroups", "ext:page-shield", {
    metrics: [COUNT], dimensions: [dim("action"), dim("resourceType")],
  }),
  zoneDef("imageResizingRequests1mGroups", "ext:image-resizing", {
    metrics: [COUNT, ...sumMetrics("requests", "originalBytes", "resizedBytes")], dimensions: [dim("contentType")],
  }),
  zoneDef("logpushHealthAdaptiveGroups", "ext:logpush-health", {
    metrics: [COUNT, ...sumMetrics("bytes", "bytesCompressed", "records", "uploads")], dimensions: [dim("destinationType"), dim("status")],
  }),
  zoneDef("dmarcReportsSourcesAdaptiveGroups", "ext:dmarc", {
    hasCount: false, metrics: [...sumMetrics("totalMatchingMessages", "dkimPass", "spfPass", "dmarc")], dimensions: [dim("disposition")],
  }),
  zoneDef("userProfilesAdaptiveGroups", "ext:user-profiles", {
    hasCount: false, timeDim: "date", timeBucket: "day", metrics: [], dimensions: [],
  }),

  // --- New zone datasets (16) ---
  zoneDef("apiGatewayGraphqlQueryAnalyticsGroups", "ext:api-gw-graphql", {
    metrics: [COUNT], dimensions: [dim("apiGatewayGraphqlQueryDepth")],
  }),
  zoneDef("apiGatewayMatchedSessionIDsAdaptiveGroups", "ext:api-gw-sessions", {
    metrics: [COUNT], dimensions: [dim("apiGatewayMatchedSessionIdentifierType")],
  }),
  zoneDef("apiGatewayMatchedSessionIDsPerEndpointAdaptiveGroups", "ext:api-gw-sessions-ep", {
    metrics: [COUNT], dimensions: [dim("responseStatusCode")],
  }),
  zoneDef("cacheReserveOperationsAdaptiveGroups", "ext:cache-reserve-ops", {
    hasCount: false, metrics: [...sumMetrics("requests")], dimensions: [dim("actionStatus"), dim("bucketName")],
  }),
  zoneDef("cacheReserveStorageAdaptiveGroups", "ext:cache-reserve-storage", {
    hasCount: false, metrics: [...maxMetrics("objectCount", "storedBytes")], dimensions: [dim("bucketName")],
  }),
  zoneDef("emailSendingAdaptiveGroups", "ext:email-sending", {
    metrics: [COUNT], dimensions: [dim("errorCause")],
  }),
  zoneDef("firewallEventsAdaptiveByTimeGroups", "ext:fw-by-time", {
    metrics: [COUNT], dimensions: [dim("wafAttackScoreClass"), dim("botScoreSrcName")],
  }),
  zoneDef("workersZoneSubrequestsAdaptiveGroups", "ext:workers-zone-subreq", {
    hasCount: false,
    metrics: [...sumMetrics("requestBodySize", "requestBodySizeUncached", "responseBodySize", "subrequests")],
    dimensions: [dim("cacheStatus"), dim("hostname")],
  }),
  zoneDef("zarazActionsAdaptiveGroups", "ext:zaraz-actions", {
    metrics: [COUNT], dimensions: [dim("actionName"), dim("toolName")],
  }),
  zoneDef("zarazAnalyticsIdentitiesAdaptiveGroups", "ext:zaraz-identities", {
    metrics: [COUNT], dimensions: [],
  }),
  zoneDef("zarazAnalyticsOrderedTrackAdaptiveGroups", "ext:zaraz-ordered-track", {
    metrics: [COUNT], dimensions: [dim("country")],
  }),
  zoneDef("zarazAnalyticsTrackAdaptiveGroups", "ext:zaraz-track-analytics", {
    metrics: [COUNT], dimensions: [dim("country")],
  }),
  zoneDef("zarazAnalyticsTriggersAdaptiveGroups", "ext:zaraz-triggers-analytics", {
    metrics: [COUNT], dimensions: [dim("country")],
  }),
  zoneDef("zarazFetchAdaptiveGroups", "ext:zaraz-fetch", {
    metrics: [COUNT], dimensions: [dim("status")],
  }),
  zoneDef("zarazTrackAdaptiveGroups", "ext:zaraz-track", {
    metrics: [COUNT], dimensions: [dim("trackName")],
  }),
  zoneDef("zarazTriggersAdaptiveGroups", "ext:zaraz-triggers", {
    metrics: [COUNT], dimensions: [dim("triggerName")],
  }),

  // API Shield sequences (Enterprise-only)
  zoneDef("apiRequestSequencesGroups", "ext:api-sequences", {
    hasCount: false, metrics: [], dimensions: [],
  }),
];

// =============================================================================
// Account-scoped datasets (122)
// =============================================================================

export const EXT_ACCOUNT_DATASETS: ExtDatasetDef[] = [
  // --- Original 24 ---
  accountDef("workersInvocationsAdaptive", "ext:workers", {
    hasCount: false,
    metrics: [...sumMetrics("requests", "errors", "cpuTimeUs", "duration", "wallTime", "subrequests", "responseBodySize")],
    dimensions: [dim("scriptName"), dim("status")],
  }),
  accountDef("workersOverviewRequestsAdaptiveGroups", "ext:workers-overview", {
    timeDim: "datetime",
    metrics: [COUNT, ...sumMetrics("cpuTimeUs")], dimensions: [dim("status")],
  }),
  accountDef("workersSubrequestsAdaptiveGroups", "ext:workers-subreq", {
    hasCount: false, metrics: [...sumMetrics("subrequests", "responseBodySize", "requestBodySize")],
    dimensions: [dim("scriptName"), dim("cacheStatus")],
  }),
  accountDef("r2OperationsAdaptiveGroups", "ext:r2-ops", {
    hasCount: false, metrics: [...sumMetrics("requests", "responseBytes", "responseObjectSize")],
    dimensions: [dim("actionType"), dim("bucketName")],
  }),
  accountDef("r2StorageAdaptiveGroups", "ext:r2-storage", {
    hasCount: false, metrics: [...maxMetrics("objectCount", "payloadSize", "metadataSize", "uploadCount")],
    dimensions: [dim("bucketName")],
  }),
  accountDef("d1AnalyticsAdaptiveGroups", "ext:d1", {
    metrics: [COUNT, ...sumMetrics("readQueries", "writeQueries", "rowsRead", "rowsWritten", "queryBatchResponseBytes")],
    dimensions: [dim("databaseId")],
  }),
  accountDef("durableObjectsInvocationsAdaptiveGroups", "ext:do-invocations", {
    hasCount: false, metrics: [...sumMetrics("requests", "errors", "responseBodySize", "wallTime")],
    dimensions: [dim("scriptName"), dim("status")],
  }),
  accountDef("durableObjectsStorageGroups", "ext:do-storage", {
    hasCount: false, metrics: [...maxMetrics("storedBytes")], dimensions: [],
  }),
  accountDef("kvOperationsAdaptiveGroups", "ext:kv-ops", {
    metrics: [COUNT, ...sumMetrics("requests", "objectBytes")], dimensions: [dim("actionType"), dim("namespaceId")],
  }),
  accountDef("kvStorageAdaptiveGroups", "ext:kv-storage", {
    hasCount: false, metrics: [...maxMetrics("byteCount", "keyCount")], dimensions: [dim("namespaceId")],
  }),
  accountDef("imagesRequestsAdaptiveGroups", "ext:images", {
    hasCount: false, metrics: [...sumMetrics("requests")], dimensions: [],
  }),
  accountDef("streamMinutesViewedAdaptiveGroups", "ext:stream", {
    metrics: [COUNT, ...sumMetrics("minutesViewed")], dimensions: [],
  }),
  accountDef("pagesFunctionsInvocationsAdaptiveGroups", "ext:pages-functions", {
    hasCount: false, metrics: [...sumMetrics("requests", "errors", "duration", "wallTime", "subrequests")],
    dimensions: [dim("scriptName"), dim("status")],
  }),
  accountDef("spectrumNetworkAnalyticsAdaptiveGroups", "ext:spectrum", {
    hasCount: false, metrics: [...sumMetrics("bits", "packets")], dimensions: [dim("direction"), dim("ipProtocolName")],
  }),
  accountDef("cdnNetworkAnalyticsAdaptiveGroups", "ext:cdn-net", {
    hasCount: false, metrics: [...sumMetrics("bits", "packets")], dimensions: [dim("direction"), dim("outcome")],
  }),
  accountDef("magicTransitNetworkAnalyticsAdaptiveGroups", "ext:magic-transit", {
    hasCount: false, metrics: [...sumMetrics("bits", "packets")], dimensions: [dim("direction"), dim("outcome")],
  }),
  accountDef("turnstileAdaptiveGroups", "ext:turnstile", {
    metrics: [COUNT], dimensions: [dim("siteKey"), dim("action")],
  }),
  accountDef("browserIsolationSessionsAdaptiveGroups", "ext:browser-isolation", {
    timeDim: "datetime", metrics: [COUNT], dimensions: [],
  }),
  accountDef("rumPageloadEventsAdaptiveGroups", "ext:rum-pageload", {
    metrics: [COUNT, ...sumMetrics("visits")], dimensions: [dim("requestHost"), dim("countryName")],
  }),
  accountDef("rumPerformanceEventsAdaptiveGroups", "ext:rum-perf", {
    metrics: [COUNT, ...sumMetrics("visits"), ...avgMetrics("pageLoadTime", "firstContentfulPaint", "requestTime", "responseTime")],
    dimensions: [dim("requestHost")],
  }),
  accountDef("rumWebVitalsEventsAdaptiveGroups", "ext:rum-vitals", {
    metrics: [
      COUNT, ...sumMetrics("visits", "lcpGood", "lcpPoor", "lcpTotal", "clsGood", "clsPoor", "clsTotal", "inpGood", "inpPoor", "inpTotal"),
      ...avgMetrics("largestContentfulPaint", "cumulativeLayoutShift", "interactionToNextPaint", "firstContentfulPaint", "timeToFirstByte"),
    ],
    dimensions: [dim("requestHost")],
  }),
  accountDef("aiGatewayRequestsAdaptiveGroups", "ext:ai-gateway", {
    metrics: [COUNT, ...sumMetrics("cachedRequests", "erroredRequests", "cost", "cachedTokensIn", "cachedTokensOut", "uncachedTokensIn", "uncachedTokensOut")],
    dimensions: [dim("model"), dim("provider")],
  }),
  accountDef("cloudflareTunnelsAnalyticsAdaptiveGroups", "ext:tunnels", {
    hasCount: false, metrics: [...sumMetrics("bits", "egressBits")], dimensions: [dim("protocol")],
  }),
  accountDef("warpDeviceAdaptiveGroups", "ext:warp", {
    metrics: [COUNT], dimensions: [dim("clientPlatform"), dim("status")],
  }),

  // --- New account datasets (84) ---

  // Network protection
  accountDef("advancedDnsProtectionNetworkAnalyticsAdaptiveGroups", "ext:adv-dns-protection", {
    hasCount: false, metrics: [...sumMetrics("bits", "packets")], dimensions: [dim("outcome")],
  }),
  accountDef("advancedTcpProtectionNetworkAnalyticsAdaptiveGroups", "ext:adv-tcp-protection", {
    hasCount: false, metrics: [...sumMetrics("bits", "packets")], dimensions: [dim("outcome")],
  }),
  accountDef("dosdNetworkAnalyticsAdaptiveGroups", "ext:dosd-net", {
    hasCount: false, metrics: [...sumMetrics("bits", "packets")], dimensions: [dim("attackId"), dim("attackVector")],
  }),
  accountDef("flowtrackdNetworkAnalyticsAdaptiveGroups", "ext:flowtrackd-net", {
    hasCount: false, metrics: [...sumMetrics("bits", "packets")], dimensions: [dim("outcome")],
  }),
  accountDef("programmableFlowProtectionNetworkAnalyticsAdaptiveGroups", "ext:pfp-net", {
    hasCount: false, metrics: [...sumMetrics("bits", "packets")], dimensions: [dim("outcome")],
  }),

  // AI
  accountDef("aiGatewayCacheAdaptiveGroups", "ext:ai-gw-cache", {
    metrics: [COUNT], dimensions: [dim("gateway"), dim("model")],
  }),
  accountDef("aiGatewayErrorsAdaptiveGroups", "ext:ai-gw-errors", {
    metrics: [COUNT], dimensions: [dim("gateway"), dim("model")],
  }),
  accountDef("aiGatewaySizeAdaptiveGroups", "ext:ai-gw-size", {
    hasCount: false, metrics: [...maxMetrics("rows")], dimensions: [dim("gateway")],
  }),
  accountDef("aiInferenceAdaptiveGroups", "ext:ai-inference", {
    metrics: [
      COUNT,
      ...sumMetrics("totalInputTokens", "totalOutputTokens", "totalInferenceTimeMs", "totalRequestBytesIn", "totalRequestBytesOut"),
    ],
    dimensions: [dim("modelId")],
  }),
  accountDef("aiSearchAPIAdaptiveGroups", "ext:ai-search-api", {
    metrics: [COUNT, ...sumMetrics("aiSearchCount", "searchCount")], dimensions: [],
  }),
  accountDef("aiSearchIngestedItemsAdaptiveGroups", "ext:ai-search-ingest", {
    metrics: [COUNT, ...sumMetrics("fileSizeBytes", "numChunks", "totalTokens")], dimensions: [dim("embeddingModel")],
  }),
  accountDef("autoRAGConfigAPIAdaptiveGroups", "ext:autorag-config", {
    hasCount: false, metrics: [...sumMetrics("aiSearchCount", "searchCount")], dimensions: [],
  }),
  accountDef("autoRAGEngineAdaptiveGroups", "ext:autorag-engine", {
    hasCount: false, metrics: [...maxMetrics("completed", "errored", "queued", "running")], dimensions: [dim("rag")],
  }),

  // Browser Rendering
  accountDef("browserIsolationUserActionsAdaptiveGroups", "ext:browser-iso-actions", {
    timeDim: "datetime", metrics: [COUNT], dimensions: [dim("type"), dim("decision")],
  }),
  accountDef("browserRenderingApiAdaptiveGroups", "ext:browser-render-api", {
    metrics: [COUNT], dimensions: [dim("endpoint")],
  }),
  accountDef("browserRenderingBindingSessionsAdaptiveGroups", "ext:browser-render-sessions", {
    metrics: [COUNT], dimensions: [],
  }),
  accountDef("browserRenderingBrowserTimeUsageAdaptiveGroups", "ext:browser-render-time", {
    metrics: [COUNT, ...sumMetrics("totalSessionDurationMs")], dimensions: [],
  }),
  accountDef("browserRenderingEventsAdaptiveGroups", "ext:browser-render-events", {
    metrics: [COUNT], dimensions: [dim("browserCloseReason")],
  }),

  // Calls (Cloudflare Calls)
  accountDef("callsTurnUsageAdaptiveGroups", "ext:calls-turn", {
    hasCount: false, metrics: [...sumMetrics("egressBytes", "ingressBytes")], dimensions: [dim("datacenterCode")],
  }),
  accountDef("callsUsageAdaptiveGroups", "ext:calls-usage", {
    hasCount: false, metrics: [...sumMetrics("egressBytes", "ingressBytes")], dimensions: [dim("appId")],
  }),

  // Containers / Cloudchamber
  accountDef("cloudchamberMetricsAdaptiveGroups", "ext:cloudchamber", {
    metrics: [COUNT, ...sumMetrics("cpuTimeSec", "rxBytes", "txBytes")], dimensions: [dim("applicationId"), dim("location")],
  }),
  accountDef("containersMetricsAdaptiveGroups", "ext:containers", {
    metrics: [COUNT, ...sumMetrics("cpuTimeSec", "rxBytes", "txBytes")], dimensions: [dim("applicationId"), dim("location")],
  }),

  // D1 extended
  accountDef("d1QueriesAdaptiveGroups", "ext:d1-queries", {
    metrics: [COUNT, ...sumMetrics("queryDurationMs", "rowsRead", "rowsReturned", "rowsWritten")],
    dimensions: [dim("databaseId")],
  }),
  accountDef("d1StorageAdaptiveGroups", "ext:d1-storage", {
    hasCount: false, metrics: [...maxMetrics("databaseSizeBytes")], dimensions: [dim("databaseId")],
  }),

  // DNS
  accountDef("dnsAnalyticsAdaptiveGroups", "ext:acct-dns", {
    metrics: [COUNT], dimensions: [dim("queryName"), dim("coloName")],
  }),
  accountDef("dnsFirewallAnalyticsAdaptiveGroups", "ext:dns-firewall", {
    metrics: [COUNT], dimensions: [dim("clusterTag"), dim("coloName")],
  }),

  // Durable Objects extended
  accountDef("durableObjectsPeriodicGroups", "ext:do-periodic", {
    metrics: [COUNT, ...sumMetrics("activeTime", "cpuTime", "subrequests", "rowsRead", "rowsWritten")],
    dimensions: [dim("namespaceId")],
  }),
  accountDef("durableObjectsSqlStorageGroups", "ext:do-sql-storage", {
    hasCount: false, metrics: [...maxMetrics("storedBytes")], dimensions: [dim("namespaceId")],
  }),
  accountDef("durableObjectsSubrequestsAdaptiveGroups", "ext:do-subreq", {
    hasCount: false, metrics: [...sumMetrics("requestBodySizeUncached")], dimensions: [dim("scriptName")],
  }),

  // Firewall (account-scoped)
  accountDef("firewallEventsAdaptiveGroups", "ext:acct-firewall", {
    metrics: [COUNT], dimensions: [dim("action")],
  }),

  // Gateway extended
  accountDef("gatewayL4DownstreamSessionsAdaptiveGroups", "ext:gw-l4-downstream", {
    metrics: [COUNT, ...sumMetrics("bytesRecvd", "bytesSent", "packetsRecvd", "packetsSent")],
    dimensions: [dim("coloCode")],
  }),
  accountDef("gatewayL4UpstreamSessionsAdaptiveGroups", "ext:gw-l4-upstream", {
    metrics: [COUNT, ...sumMetrics("bytesRecvd", "bytesSent", "packetsRecvd", "packetsSent")],
    dimensions: [dim("coloCode")],
  }),
  accountDef("gatewayResolverByCategoryAdaptiveGroups", "ext:gw-resolver-category", {
    metrics: [COUNT], dimensions: [dim("categoryId")],
  }),
  accountDef("gatewayResolverByCustomResolverGroups", "ext:gw-resolver-custom", {
    timeDim: "datetime",
    metrics: [COUNT], dimensions: [dim("customResolverAddress")],
  }),
  accountDef("gatewayResolverByRuleExecutionPerformanceAdaptiveGroups", "ext:gw-resolver-perf", {
    timeDim: "datetime",
    metrics: [COUNT], dimensions: [],
  }),

  // HTTP (account-scoped aggregates)
  accountDef("httpRequestsAdaptiveGroups", "ext:acct-http", {
    metrics: [COUNT, ...sumMetrics("edgeRequestBytes", "edgeResponseBytes", "edgeTimeToFirstByteMs", "originResponseDurationMs", "visits")],
    dimensions: [],
  }),
  accountDef("httpRequestsOverviewAdaptiveGroups", "ext:acct-http-overview", {
    hasCount: false,
    metrics: [...sumMetrics("requests", "bytes", "cachedRequests", "cachedBytes", "pageViews", "visits")],
    dimensions: [dim("clientCountryName")],
  }),

  // Hyperdrive
  accountDef("hyperdriveQueriesAdaptiveGroups", "ext:hyperdrive", {
    metrics: [COUNT, ...sumMetrics("queryBytes", "resultBytes", "queryLatency", "connectionLatency")],
    dimensions: [dim("configId"), dim("cacheStatus")],
  }),

  // Live Input (Stream)
  accountDef("liveInputEventsAdaptiveGroups", "ext:live-input", {
    metrics: [COUNT], dimensions: [dim("inputId"), dim("eventCode")],
  }),

  // Log Explorer
  accountDef("logExplorerIngestionAdaptiveGroups", "ext:log-explorer", {
    hasCount: false, metrics: [...sumMetrics("billableBytes", "totalBytes")], dimensions: [dim("dataset")],
  }),

  // Logpush Health (account-scoped)
  accountDef("logpushHealthAdaptiveGroups", "ext:acct-logpush-health", {
    metrics: [COUNT, ...sumMetrics("bytes", "bytesCompressed", "records", "uploads")],
    dimensions: [dim("destinationType"), dim("status")],
  }),

  // Magic Transit extended
  accountDef("magicEndpointHealthCheckAdaptiveGroups", "ext:magic-endpoint-health", {
    metrics: [COUNT, ...sumMetrics("failures", "total")], dimensions: [dim("name"), dim("endpoint")],
  }),
  accountDef("magicFirewallNetworkAnalyticsAdaptiveGroups", "ext:magic-fw-net", {
    hasCount: false, metrics: [...sumMetrics("bits", "packets")], dimensions: [dim("outcome")],
  }),
  accountDef("magicFirewallRateLimitNetworkAnalyticsAdaptiveGroups", "ext:magic-fw-ratelimit", {
    hasCount: false, metrics: [...sumMetrics("bits", "packets")], dimensions: [],
  }),
  accountDef("magicFirewallSamplesAdaptiveGroups", "ext:magic-fw-samples", {
    hasCount: false, timeDim: "datetime", metrics: [...sumMetrics("bits", "packets")], dimensions: [dim("ruleId")],
  }),
  accountDef("magicIDPSNetworkAnalyticsAdaptiveGroups", "ext:magic-idps", {
    hasCount: false, metrics: [...sumMetrics("bits", "packets")], dimensions: [dim("outcome")],
  }),
  accountDef("magicTransitTunnelHealthCheckSLOsAdaptiveGroups", "ext:magic-tunnel-slo", {
    metrics: [COUNT], dimensions: [dim("tunnelId"), dim("status")],
  }),
  accountDef("magicTransitTunnelHealthChecksAdaptiveGroups", "ext:magic-tunnel-health", {
    metrics: [COUNT], dimensions: [dim("tunnelName"), dim("resultStatus")],
  }),
  accountDef("magicTransitTunnelTrafficAdaptiveGroups", "ext:magic-tunnel-traffic", {
    hasCount: false, metrics: [...sumMetrics("bits", "packets")], dimensions: [dim("direction"), dim("tunnelName")],
  }),
  // Note: Capital M – CF schema uses "MagicWANConnectorMetricsAdaptiveGroups"
  accountDef("MagicWANConnectorMetricsAdaptiveGroups", "ext:magic-wan-connector", {
    hasCount: false, timeDim: "datetime", metrics: [...maxMetrics("haState", "interfaceCount")],
    dimensions: [dim("mconnConnectorID")],
  }),

  // MNM (Magic Network Monitoring)
  accountDef("mnmFlowDataAdaptiveGroups", "ext:mnm-flow", {
    hasCount: false, metrics: [...sumMetrics("bits", "packets", "egressBits", "egressPackets")], dimensions: [dim("deviceID")],
  }),
  accountDef("mnmAWSVPCFlowDataAdaptiveGroups", "ext:mnm-aws-vpc", {
    hasCount: false, metrics: [...sumMetrics("bits", "packets", "egressBits", "egressPackets")], dimensions: [dim("action")],
  }),

  // NEL (account-scoped)
  accountDef("nelReportsAdaptiveGroups", "ext:acct-nel", {
    metrics: [COUNT], dimensions: [dim("type"), dim("phase")],
  }),

  // OHTTP
  accountDef("ohttpMetricsAdaptiveGroups", "ext:ohttp", {
    metrics: [COUNT, ...sumMetrics("bytesToClient", "bytesToGateway")], dimensions: [dim("endpoint")],
  }),

  // Pipelines
  accountDef("pipelinesDeliveryAdaptiveGroups", "ext:pipelines-delivery", {
    metrics: [COUNT, ...sumMetrics("deliveredBytes")], dimensions: [dim("pipelineId")],
  }),
  accountDef("pipelinesIngestionAdaptiveGroups", "ext:pipelines-ingest", {
    metrics: [COUNT, ...sumMetrics("ingestedBytes", "ingestedRecords")], dimensions: [dim("pipelineId")],
  }),
  accountDef("pipelinesOperatorAdaptiveGroups", "ext:pipelines-operator", {
    hasCount: false, metrics: [...sumMetrics("bytesIn", "recordsIn", "decodeErrors")], dimensions: [dim("pipelineId")],
  }),
  accountDef("pipelinesSinkAdaptiveGroups", "ext:pipelines-sink", {
    hasCount: false, metrics: [...sumMetrics("bytesWritten", "filesWritten", "recordsWritten")], dimensions: [dim("pipelineId")],
  }),
  accountDef("pipelinesUserErrorsAdaptiveGroups", "ext:pipelines-errors", {
    metrics: [COUNT], dimensions: [dim("errorType"), dim("pipelineId")],
  }),

  // Queues
  accountDef("queueBacklogAdaptiveGroups", "ext:queue-backlog", {
    hasCount: false, metrics: [...avgMetrics("bytes", "messages")], dimensions: [dim("queueId")],
  }),
  accountDef("queueConsumerMetricsAdaptiveGroups", "ext:queue-consumer", {
    hasCount: false, metrics: [...avgMetrics("concurrency")], dimensions: [dim("queueId")],
  }),
  accountDef("queueDelayedBacklogAdaptiveGroups", "ext:queue-delayed", {
    hasCount: false, metrics: [...avgMetrics("messages")], dimensions: [dim("queueId")],
  }),
  accountDef("queueMessageOperationsAdaptiveGroups", "ext:queue-msg-ops", {
    metrics: [COUNT, ...sumMetrics("billableOperations", "bytes")], dimensions: [dim("actionType"), dim("queueId")],
  }),

  // Realtime Kit (Calls v2)
  accountDef("realtimeKitUsageAdaptiveGroups", "ext:realtime-kit", {
    metrics: [COUNT, ...sumMetrics("audioMinutes", "mediaMinutes")], dimensions: [dim("appId")],
  }),

  // Sinkhole
  accountDef("sinkholeRequestLogsAdaptiveGroups", "ext:sinkhole", {
    timeDim: "datetime", metrics: [COUNT], dimensions: [dim("destinationAddress")],
  }),

  // Sippy (R2 migration)
  accountDef("sippyOperationsAdaptiveGroups", "ext:sippy", {
    metrics: [COUNT, ...sumMetrics("size")], dimensions: [dim("action"), dim("bucket")],
  }),

  // Stream extended
  accountDef("streamCMCDAdaptiveGroups", "ext:stream-cmcd", {
    metrics: [COUNT, ...sumMetrics("millisecondsViewed")], dimensions: [dim("contentId")],
  }),

  // ToMarkdown
  accountDef("toMarkdownConversionAdaptiveGroups", "ext:to-markdown", {
    metrics: [COUNT], dimensions: [],
  }),

  // Vectorize
  accountDef("vectorizeQueriesAdaptiveGroups", "ext:vectorize-queries", {
    hasCount: false, metrics: [...sumMetrics("queriedVectorDimensions")], dimensions: [dim("vectorizeIndexId")],
  }),
  accountDef("vectorizeStorageAdaptiveGroups", "ext:vectorize-storage", {
    hasCount: false, metrics: [...maxMetrics("storedVectorDimensions")], dimensions: [dim("vectorizeIndexId")],
  }),
  accountDef("vectorizeV2OperationsAdaptiveGroups", "ext:vectorize-v2-ops", {
    metrics: [COUNT], dimensions: [dim("indexName"), dim("operation")],
  }),
  accountDef("vectorizeV2QueriesAdaptiveGroups", "ext:vectorize-v2-queries", {
    metrics: [COUNT, ...sumMetrics("queriedVectorDimensions", "servedVectorCount", "requestDurationMs")],
    dimensions: [dim("indexName")],
  }),
  accountDef("vectorizeV2StorageAdaptiveGroups", "ext:vectorize-v2-storage", {
    hasCount: false, metrics: [...maxMetrics("storedVectorDimensions", "vectorCount")], dimensions: [dim("indexName")],
  }),
  accountDef("vectorizeV2WritesAdaptiveGroups", "ext:vectorize-v2-writes", {
    metrics: [COUNT, ...sumMetrics("addedVectorCount", "deletedVectorCount", "requestDurationMs")],
    dimensions: [dim("indexName")],
  }),

  // Video (Stream)
  accountDef("videoBufferEventsAdaptiveGroups", "ext:video-buffer", {
    metrics: [COUNT], dimensions: [dim("uid"), dim("clientCountryName")],
  }),
  accountDef("videoPlaybackEventsAdaptiveGroups", "ext:video-playback", {
    metrics: [COUNT, ...sumMetrics("timeViewedMinutes")], dimensions: [dim("uid"), dim("clientCountryName")],
  }),
  accountDef("videoQualityEventsAdaptiveGroups", "ext:video-quality", {
    metrics: [COUNT], dimensions: [dim("qualityResolution"), dim("uid")],
  }),

  // Workers extended
  accountDef("workerPlacementAdaptiveGroups", "ext:worker-placement", {
    hasCount: false, metrics: [...sumMetrics("requests", "requestDuration")], dimensions: [dim("coloCode"), dim("placementUsed")],
  }),
  accountDef("workersAnalyticsEngineAdaptiveGroups", "ext:workers-ae", {
    metrics: [COUNT], dimensions: [dim("dataset")],
  }),
  accountDef("workersBuildsBuildMinutesAdaptiveGroups", "ext:workers-builds", {
    hasCount: false, timeDim: "datetime", metrics: [...sumMetrics("buildMinutes")], dimensions: [],
  }),
  accountDef("workersOverviewDataAdaptiveGroups", "ext:workers-overview-data", {
    hasCount: false, timeDim: "datetime",
    metrics: [...sumMetrics("standardCpuTimeUs", "unboundDurationUs")], dimensions: [dim("usageModel")],
  }),
  accountDef("workersVpcConnectionAdaptiveGroups", "ext:workers-vpc", {
    metrics: [COUNT, ...sumMetrics("connectionLatency", "dnsLatency")], dimensions: [dim("status"), dim("targetId")],
  }),

  // Workflows
  accountDef("workflowsAdaptiveGroups", "ext:workflows", {
    metrics: [COUNT, ...sumMetrics("cpuTime", "executionDuration", "wallTime", "stepCount")],
    dimensions: [dim("workflowName"), dim("eventType")],
  }),

  // Zaraz (account-scoped)
  accountDef("zarazTrackAdaptiveGroups", "ext:acct-zaraz-track", {
    metrics: [COUNT], dimensions: [dim("trackName")],
  }),
  accountDef("zarazTriggersAdaptiveGroups", "ext:acct-zaraz-triggers", {
    metrics: [COUNT], dimensions: [dim("triggerName")],
  }),

  // Gateway L4/L7 sessions
  accountDef("gatewayL4SessionsAdaptiveGroups", "ext:gw-l4-sessions", {
    metrics: [COUNT], dimensions: [dim("action"), dim("transport")],
  }),
  accountDef("gatewayL7RequestsAdaptiveGroups", "ext:gw-l7-requests", {
    metrics: [COUNT], dimensions: [dim("action"), dim("httpHost")],
  }),

  // DDoS attack analytics
  accountDef("dosdAttackAnalyticsGroups", "ext:dosd-attacks", {
    hasCount: false, timeDim: "startDatetime", timeBucket: "hour",
    metrics: [], dimensions: [],
  }),

  // Aegis (Dedicated CDN Egress IPs)
  accountDef("aegisIpUtilizationAdaptiveGroups", "ext:aegis-ip-util", {
    hasCount: false, timeDim: "datetimeFiveMinutes", timeBucket: "hour",
    metrics: [...avgMetrics("utilization"), ...maxMetrics("utilization")], dimensions: [],
  }),

  // Magic WAN Connector telemetry
  accountDef("mconnTelemetrySnapshotsAdaptiveGroups", "ext:mconn-snapshots", {
    metrics: [COUNT, ...maxMetrics("loadAverage1m", "loadAverage5m", "memoryAvailableBytes", "memoryTotalBytes", "cpuCount")],
    dimensions: [dim("connectorId")],
  }),
  accountDef("mconnTelemetrySnapshotMountsAdaptiveGroups", "ext:mconn-mounts", {
    metrics: [COUNT, ...maxMetrics("availableBytes", "totalBytes")], dimensions: [dim("connectorId"), dim("mountPoint")],
  }),
  accountDef("mconnTelemetrySnapshotThermalsAdaptiveGroups", "ext:mconn-thermals", {
    metrics: [COUNT, ...maxMetrics("currentCelcius", "criticalCelcius")], dimensions: [dim("connectorId"), dim("label")],
  }),
  accountDef("mconnTelemetryEventsAdaptiveGroups", "ext:mconn-events", {
    metrics: [COUNT], dimensions: [dim("connectorId")],
  }),
  accountDef("mconnTelemetrySnapshotDisksAdaptiveGroups", "ext:mconn-disks", {
    metrics: [COUNT, ...sumMetrics("reads", "writes", "sectorsRead", "sectorsWritten")],
    dimensions: [dim("connectorId")],
  }),
  accountDef("mconnTelemetrySnapshotInterfacesAdaptiveGroups", "ext:mconn-interfaces", {
    metrics: [COUNT], dimensions: [dim("connectorId")],
  }),
  accountDef("mconnTelemetrySnapshotNetdevsAdaptiveGroups", "ext:mconn-netdevs", {
    metrics: [COUNT, ...sumMetrics("recvBytes", "recvPackets", "sentBytes", "sentPackets")], dimensions: [dim("connectorId")],
  }),
  accountDef("mconnTelemetrySnapshotTunnelsAdaptiveGroups", "ext:mconn-tunnels", {
    metrics: [COUNT], dimensions: [dim("connectorId")],
  }),

  // Zero Trust
  accountDef("zeroTrustPrivateNetworkDiscoveryGroups", "ext:zt-network-discovery", {
    metrics: [COUNT], dimensions: [dim("destinationIP"), dim("destinationPort")],
  }),
];

/** All extension dataset keys (for logging / status) */
export const ALL_EXT_KEYS = [
  ...EXT_ZONE_DATASETS.map((d) => d.key),
  ...EXT_ACCOUNT_DATASETS.map((d) => d.key),
];
