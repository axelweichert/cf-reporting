/**
 * Viewer-role request validation for the Cloudflare API proxy.
 *
 * Operators get unrestricted proxy access.
 * Viewers are restricted to:
 *   - GraphQL: AST-parsed, only read-only queries targeting allowlisted
 *     analytics datasets via viewer → zones/accounts → dataset path.
 *     Mutations, subscriptions, introspection, and fragments are rejected.
 *   - REST GET: only allowlisted path patterns (report-relevant endpoints).
 */

import { parse, Kind, visit } from "graphql";
import type {
  DocumentNode,
  OperationDefinitionNode,
  FieldNode,
  SelectionSetNode,
} from "graphql";

// ---------------------------------------------------------------------------
// GraphQL – AST-based validation
// ---------------------------------------------------------------------------

/** Analytics datasets the report UI queries. */
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

/** Scope containers directly under `viewer`. */
const ALLOWED_SCOPE_FIELDS: ReadonlySet<string> = new Set([
  "zones",
  "accounts",
]);

/**
 * Validate a GraphQL query for viewer safety using AST parsing.
 * Returns null if valid, or an error message string.
 *
 * Enforced rules:
 *  1. Query must parse as valid GraphQL.
 *  2. Only a single anonymous or named `query` operation is allowed
 *     (no mutations, subscriptions).
 *  3. No fragment definitions (prevents hiding disallowed fields).
 *  4. No introspection fields (__schema, __type, __typename at root).
 *  5. The operation's top-level field must be `viewer`.
 *  6. Under `viewer`, only `zones` or `accounts` fields are allowed.
 *  7. Under `zones`/`accounts`, only fields in the ALLOWED_DATASETS set.
 *  8. Size limit (4 KB) as a DoS guard before parsing.
 */
export function validateViewerGraphQL(query: string): string | null {
  if (!query || typeof query !== "string") {
    return "Missing query";
  }

  if (query.length > 4096) {
    return "Query too large";
  }

  // --- Parse ---
  let doc: DocumentNode;
  try {
    doc = parse(query);
  } catch (e) {
    return `Invalid GraphQL: ${(e as Error).message}`;
  }

  // --- Reject fragments ---
  for (const def of doc.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) {
      return "Fragment definitions are not allowed";
    }
  }

  // --- Collect operations ---
  const ops = doc.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION,
  );

  if (ops.length === 0) {
    return "No operation found";
  }
  if (ops.length > 1) {
    return "Only a single operation is allowed";
  }

  const op = ops[0];

  // --- Only queries ---
  if (op.operation !== "query") {
    return `Operation type "${op.operation}" is not allowed`;
  }

  // --- Walk the AST with depth-based rules ---
  // depth 0 = operation root selections  → must be exactly `viewer`
  // depth 1 = viewer children             → must be `zones` or `accounts`
  // depth 2 = scope children              → must be allowlisted datasets
  // depth 3+ = free (result field selections)

  const err = validateSelections(op.selectionSet, 0);
  if (err) return err;

  // --- Global introspection sweep (catches any depth) ---
  let introspectionField: string | null = null;
  visit(doc, {
    Field(node: FieldNode) {
      const name = node.name.value;
      if (name === "__schema" || name === "__type") {
        introspectionField = name;
      }
    },
  });
  if (introspectionField) {
    return "Introspection queries are not allowed";
  }

  return null;
}

function validateSelections(
  selectionSet: SelectionSetNode | undefined,
  depth: number,
): string | null {
  if (!selectionSet) return null;

  for (const sel of selectionSet.selections) {
    // Inline fragments and fragment spreads are not allowed
    if (sel.kind === Kind.INLINE_FRAGMENT) {
      return "Inline fragments are not allowed";
    }
    if (sel.kind === Kind.FRAGMENT_SPREAD) {
      return "Fragment spreads are not allowed";
    }

    // It's a field
    const field = sel as FieldNode;
    const name = field.name.value;

    if (depth === 0) {
      // Operation root – only `viewer`
      if (name !== "viewer") {
        return `Root field "${name}" is not allowed (must be "viewer")`;
      }
    } else if (depth === 1) {
      // Under viewer – only zones / accounts
      if (!ALLOWED_SCOPE_FIELDS.has(name)) {
        return `Field "${name}" under viewer is not allowed (use "zones" or "accounts")`;
      }
    } else if (depth === 2) {
      // Under zones/accounts – only allowlisted datasets
      if (!ALLOWED_DATASETS.has(name)) {
        return `Dataset "${name}" is not allowed`;
      }
    }
    // depth >= 3: result sub-fields – allowed freely

    // Recurse into children (enforce structure at depth < 3, free after)
    const childErr = validateSelections(field.selectionSet, depth + 1);
    if (childErr) return childErr;
  }

  return null;
}

// ---------------------------------------------------------------------------
// REST – path pattern allowlist  (unchanged, already structural)
// ---------------------------------------------------------------------------

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
 * Returns null if valid, or an error message string.
 */
export function validateViewerRestPath(cfPath: string): string | null {
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
      if (!validateWildcard(parts, i, part)) return false;
    } else {
      if (part !== seg) return false;
    }
  }

  return true;
}

function validateWildcard(parts: string[], index: number, value: string): boolean {
  if (index >= 2 && parts[index - 1] === "settings") {
    return ALLOWED_SETTINGS_KEYS.has(value);
  }
  if (index >= 2 && parts[index - 1] === "phases") {
    return ALLOWED_RULESET_PHASES.has(value);
  }
  return false;
}
