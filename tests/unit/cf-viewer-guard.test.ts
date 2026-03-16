import { describe, it, expect } from "vitest";
import { validateViewerGraphQL, validateViewerRestPath } from "@/lib/cf-viewer-guard";

// ---------------------------------------------------------------------------
// GraphQL validation
// ---------------------------------------------------------------------------

describe("validateViewerGraphQL", () => {
  it("allows a valid httpRequestsAdaptiveGroups query", () => {
    const query = `{
      viewer {
        zones(filter: { zoneTag: "abc123def456abc123def456abc123de" }) {
          httpRequestsAdaptiveGroups(
            limit: 1000
            filter: { datetime_geq: "2024-01-01T00:00:00Z", datetime_lt: "2024-01-02T00:00:00Z" }
            orderBy: [datetimeHour_ASC]
          ) {
            count
            dimensions { datetimeHour cacheStatus }
            sum { edgeResponseBytes }
          }
        }
      }
    }`;
    expect(validateViewerGraphQL(query)).toBeNull();
  });

  it("allows a valid account-scoped gateway query", () => {
    const query = `{
      viewer {
        accounts(filter: { accountTag: "abc123def456abc123def456abc123de" }) {
          gatewayResolverQueriesAdaptiveGroups(
            limit: 1000
            filter: { datetime_geq: "2024-01-01T00:00:00Z", datetime_lt: "2024-01-02T00:00:00Z" }
          ) {
            count
            dimensions { datetimeHour }
          }
        }
      }
    }`;
    expect(validateViewerGraphQL(query)).toBeNull();
  });

  it("allows multi-dataset queries (batched)", () => {
    const query = `{
      viewer {
        zones(filter: { zoneTag: "abc123" }) {
          threats: firewallEventsAdaptiveGroups(limit: 100 filter: { action: "block" }) {
            count
          }
          ddos: firewallEventsAdaptiveGroups(limit: 100 filter: { source: "l7ddos" }) {
            count
          }
        }
      }
    }`;
    expect(validateViewerGraphQL(query)).toBeNull();
  });

  it("allows all 13 known datasets", () => {
    const datasets = [
      "httpRequestsAdaptiveGroups",
      "httpRequestsOverviewAdaptiveGroups",
      "firewallEventsAdaptiveGroups",
      "dnsAnalyticsAdaptiveGroups",
      "healthCheckEventsAdaptive",
      "dosdAttackAnalyticsGroups",
      "apiGatewayMatchedSessionIDsPerEndpointFlattenedAdaptiveGroups",
      "apiGatewayMatchedSessionIDsPerEndpointAdaptiveGroups",
      "gatewayResolverQueriesAdaptiveGroups",
      "gatewayResolverByCategoryAdaptiveGroups",
      "gatewayL4SessionsAdaptiveGroups",
      "gatewayL7RequestsAdaptiveGroups",
      "accessLoginRequestsAdaptiveGroups",
    ];
    for (const ds of datasets) {
      const query = `{ viewer { zones(filter: { zoneTag: "x" }) { ${ds}(limit: 10) { count } } } }`;
      expect(validateViewerGraphQL(query)).toBeNull();
    }
  });

  it("rejects mutations", () => {
    const query = `mutation { deleteZone(id: "abc") { success } }`;
    expect(validateViewerGraphQL(query)).toBe("Mutations are not allowed");
  });

  it("rejects introspection via __schema", () => {
    const query = `{ __schema { types { name } } }`;
    expect(validateViewerGraphQL(query)).toBe("Introspection queries are not allowed");
  });

  it("rejects introspection via __type", () => {
    const query = `{ viewer { __type(name: "Zone") { fields { name } } } }`;
    expect(validateViewerGraphQL(query)).toBe("Introspection queries are not allowed");
  });

  it("rejects unknown datasets", () => {
    const query = `{ viewer { zones(filter: { zoneTag: "x" }) { someUnknownDataset(limit: 10) { count } } } }`;
    expect(validateViewerGraphQL(query)).toBe("Dataset not allowed: someUnknownDataset");
  });

  it("rejects queries without viewer root", () => {
    const query = `{ zones { httpRequestsAdaptiveGroups(limit: 10) { count } } }`;
    expect(validateViewerGraphQL(query)).toBe("Query must target the viewer root");
  });

  it("rejects oversized queries", () => {
    const query = "{ viewer { " + "x".repeat(4100) + " } }";
    expect(validateViewerGraphQL(query)).toBe("Query too large");
  });

  it("rejects empty/missing queries", () => {
    expect(validateViewerGraphQL("")).toBe("Missing query");
    expect(validateViewerGraphQL(null as unknown as string)).toBe("Missing query");
  });

  it("rejects queries with no datasets", () => {
    const query = `{ viewer { zones(filter: { zoneTag: "x" }) { } } }`;
    expect(validateViewerGraphQL(query)).toBe("No recognized datasets in query");
  });
});

// ---------------------------------------------------------------------------
// REST path validation
// ---------------------------------------------------------------------------

describe("validateViewerRestPath", () => {
  const ZONE_ID = "abcdef0123456789abcdef0123456789";
  const ACCOUNT_ID = "fedcba9876543210fedcba9876543210";

  it("allows zone-scoped DNS records", () => {
    expect(validateViewerRestPath(`/zones/${ZONE_ID}/dns_records`)).toBeNull();
  });

  it("allows zone-scoped firewall rules", () => {
    expect(validateViewerRestPath(`/zones/${ZONE_ID}/firewall/rules`)).toBeNull();
  });

  it("allows zone-scoped SSL certificate packs", () => {
    expect(validateViewerRestPath(`/zones/${ZONE_ID}/ssl/certificate_packs`)).toBeNull();
  });

  it("allows zone-scoped healthchecks", () => {
    expect(validateViewerRestPath(`/zones/${ZONE_ID}/healthchecks`)).toBeNull();
  });

  it("allows zone-scoped API gateway operations", () => {
    expect(validateViewerRestPath(`/zones/${ZONE_ID}/api_gateway/operations`)).toBeNull();
  });

  it("allows zone-scoped API gateway discovery", () => {
    expect(validateViewerRestPath(`/zones/${ZONE_ID}/api_gateway/discovery/operations`)).toBeNull();
  });

  it("allows zone-scoped API gateway configuration", () => {
    expect(validateViewerRestPath(`/zones/${ZONE_ID}/api_gateway/configuration`)).toBeNull();
  });

  it("allows zone-scoped settings with valid keys", () => {
    for (const key of ["ssl", "min_tls_version", "tls_1_3", "always_use_https", "http2", "http3", "0rtt"]) {
      expect(validateViewerRestPath(`/zones/${ZONE_ID}/settings/${key}`)).toBeNull();
    }
  });

  it("allows zone-scoped rulesets with valid phases", () => {
    for (const phase of ["http_request_firewall_custom", "http_request_firewall_managed", "http_request_sbfm", "http_ratelimit"]) {
      expect(validateViewerRestPath(`/zones/${ZONE_ID}/rulesets/phases/${phase}/entrypoint`)).toBeNull();
    }
  });

  it("allows account-scoped gateway categories", () => {
    expect(validateViewerRestPath(`/accounts/${ACCOUNT_ID}/gateway/categories`)).toBeNull();
  });

  it("allows account-scoped subscriptions", () => {
    expect(validateViewerRestPath(`/accounts/${ACCOUNT_ID}/subscriptions`)).toBeNull();
  });

  it("allows account-scoped devices", () => {
    expect(validateViewerRestPath(`/accounts/${ACCOUNT_ID}/devices`)).toBeNull();
  });

  it("allows account-scoped devices/posture", () => {
    expect(validateViewerRestPath(`/accounts/${ACCOUNT_ID}/devices/posture`)).toBeNull();
  });

  it("allows account-scoped access users", () => {
    expect(validateViewerRestPath(`/accounts/${ACCOUNT_ID}/access/users`)).toBeNull();
  });

  it("allows account-scoped access apps", () => {
    expect(validateViewerRestPath(`/accounts/${ACCOUNT_ID}/access/apps`)).toBeNull();
  });

  it("rejects unknown paths", () => {
    expect(validateViewerRestPath(`/zones/${ZONE_ID}/purge_cache`)).not.toBeNull();
  });

  it("rejects arbitrary REST paths", () => {
    expect(validateViewerRestPath("/user/tokens")).not.toBeNull();
  });

  it("rejects paths with invalid zone IDs (not hex)", () => {
    expect(validateViewerRestPath("/zones/not-a-hex-id-at-all!!!/dns_records")).not.toBeNull();
  });

  it("rejects settings with unknown keys", () => {
    expect(validateViewerRestPath(`/zones/${ZONE_ID}/settings/development_mode`)).not.toBeNull();
  });

  it("rejects rulesets with unknown phases", () => {
    expect(validateViewerRestPath(`/zones/${ZONE_ID}/rulesets/phases/http_request_transform/entrypoint`)).not.toBeNull();
  });

  it("rejects path traversal attempts", () => {
    expect(validateViewerRestPath(`/zones/${ZONE_ID}/../../user/tokens`)).not.toBeNull();
  });
});
