/**
 * Viewer-role request validation for the Cloudflare API proxy.
 *
 * Operators get unrestricted proxy access.
 * Viewers are restricted to:
 *   - GraphQL: only allowlisted read-only analytics datasets, no mutations/introspection
 *   - REST GET: only allowlisted path patterns (report-relevant endpoints)
 */

// ---------------------------------------------------------------------------
// GraphQL dataset allowlist
// ---------------------------------------------------------------------------

const ALLOWED_DATASETS: ReadonlySet<string> = new Set([
  // Web / App Security
  "httpRequestsAdaptiveGroups",
  "httpRequestsOverviewAdaptiveGroups",
  "firewallEventsAdaptiveGroups",
  "dnsAnalyticsAdaptiveGroups",
  "healthCheckEventsAdaptive",
  "dosdAttackAnalyticsGroups",
  "apiGatewayMatchedSessionIDsPerEndpointFlattenedAdaptiveGroups",
  "apiGatewayMatchedSessionIDsPerEndpointAdaptiveGroups",
  // Zero Trust
  "gatewayResolverQueriesAdaptiveGroups",
  "gatewayResolverByCategoryAdaptiveGroups",
  "gatewayL4SessionsAdaptiveGroups",
  "gatewayL7RequestsAdaptiveGroups",
  "accessLoginRequestsAdaptiveGroups",
]);

/** Extract dataset names referenced in a GraphQL query string. */
function extractDatasets(query: string): string[] {
  // Match identifiers immediately followed by "(" that look like dataset calls.
  // Dataset names are camelCase identifiers used as field selectors with arguments.
  const re = /\b([a-zA-Z][a-zA-Z0-9]+)\s*\(/g;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(query)) !== null) {
    const name = match[1];
    // Skip known GraphQL structural keywords and CF wrapper fields
    if (!STRUCTURAL_KEYWORDS.has(name)) {
      names.push(name);
    }
  }
  return names;
}

const STRUCTURAL_KEYWORDS: ReadonlySet<string> = new Set([
  "query", "mutation", "subscription", "fragment",
  "viewer", "zones", "accounts", "filter", "orderBy",
]);

/**
 * Validate a GraphQL query for viewer safety.
 * Returns null if valid, or an error message string.
 */
export function validateViewerGraphQL(query: string): string | null {
  if (!query || typeof query !== "string") {
    return "Missing query";
  }

  // Size limit – no legitimate report query exceeds 4 KB
  if (query.length > 4096) {
    return "Query too large";
  }

  // Block mutations
  if (/\bmutation\b/i.test(query)) {
    return "Mutations are not allowed";
  }

  // Block introspection
  if (/__schema\b|__type\b|__typename\b.*\{/i.test(query)) {
    return "Introspection queries are not allowed";
  }

  // Must target the viewer root (all CF analytics queries do)
  if (!/\bviewer\s*\{/.test(query)) {
    return "Query must target the viewer root";
  }

  // Extract and validate all dataset references
  const datasets = extractDatasets(query);
  if (datasets.length === 0) {
    return "No recognized datasets in query";
  }

  for (const ds of datasets) {
    if (!ALLOWED_DATASETS.has(ds)) {
      return `Dataset not allowed: ${ds}`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// REST path allowlist
// ---------------------------------------------------------------------------

// Hex string pattern for Cloudflare zone/account IDs (32-char hex)
const HEX_ID = /^[0-9a-f]{32}$/;

interface PathPattern {
  segments: Array<string | "ZONE_ID" | "ACCOUNT_ID" | "WILDCARD">;
}

const ALLOWED_REST_PATTERNS: PathPattern[] = [
  // Zone-scoped endpoints
  { segments: ["zones", "ZONE_ID", "dns_records"] },
  { segments: ["zones", "ZONE_ID", "firewall", "rules"] },
  { segments: ["zones", "ZONE_ID", "rulesets", "phases", "WILDCARD", "entrypoint"] },
  { segments: ["zones", "ZONE_ID", "ssl", "certificate_packs"] },
  { segments: ["zones", "ZONE_ID", "settings", "WILDCARD"] },
  { segments: ["zones", "ZONE_ID", "healthchecks"] },
  { segments: ["zones", "ZONE_ID", "api_gateway", "operations"] },
  { segments: ["zones", "ZONE_ID", "api_gateway", "discovery", "operations"] },
  { segments: ["zones", "ZONE_ID", "api_gateway", "configuration"] },
  // Account-scoped endpoints
  { segments: ["accounts", "ACCOUNT_ID", "gateway", "categories"] },
  { segments: ["accounts", "ACCOUNT_ID", "subscriptions"] },
  { segments: ["accounts", "ACCOUNT_ID", "devices"] },
  { segments: ["accounts", "ACCOUNT_ID", "devices", "posture"] },
  { segments: ["accounts", "ACCOUNT_ID", "access", "users"] },
  { segments: ["accounts", "ACCOUNT_ID", "access", "apps"] },
];

// Allowed values for wildcard segments (settings keys, ruleset phases)
const ALLOWED_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "ssl", "min_tls_version", "tls_1_3", "always_use_https",
  "automatic_https_rewrites", "opportunistic_encryption",
  "0rtt", "http2", "http3",
]);

const ALLOWED_RULESET_PHASES: ReadonlySet<string> = new Set([
  "http_request_firewall_custom",
  "http_request_firewall_managed",
  "http_request_sbfm",
  "http_ratelimit",
]);

/**
 * Validate a REST path for viewer safety.
 * @param cfPath – path without leading slash, e.g. "zones/abc123/dns_records"
 * Returns null if valid, or an error message string.
 */
export function validateViewerRestPath(cfPath: string): string | null {
  // Strip leading slash and query string
  const pathOnly = cfPath.replace(/^\//, "").split("?")[0];
  const parts = pathOnly.split("/").filter(Boolean);

  for (const pattern of ALLOWED_REST_PATTERNS) {
    if (matchPattern(parts, pattern)) return null;
  }

  return `REST path not allowed: /${pathOnly}`;
}

function matchPattern(parts: string[], pattern: PathPattern): boolean {
  if (parts.length !== pattern.segments.length) return false;

  for (let i = 0; i < pattern.segments.length; i++) {
    const seg = pattern.segments[i];
    const part = parts[i];

    if (seg === "ZONE_ID" || seg === "ACCOUNT_ID") {
      if (!HEX_ID.test(part)) return false;
    } else if (seg === "WILDCARD") {
      // Validate wildcard values contextually
      if (!validateWildcard(parts, i, part)) return false;
    } else {
      if (part !== seg) return false;
    }
  }

  return true;
}

function validateWildcard(parts: string[], index: number, value: string): boolean {
  // settings/{key}
  if (index >= 2 && parts[index - 1] === "settings") {
    return ALLOWED_SETTINGS_KEYS.has(value);
  }
  // rulesets/phases/{phase}/entrypoint
  if (index >= 2 && parts[index - 1] === "phases") {
    return ALLOWED_RULESET_PHASES.has(value);
  }
  return false;
}
