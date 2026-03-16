import { describe, it, expect } from "vitest";
import { validateViewerGraphQL, validateViewerRestPath } from "@/lib/cf-viewer-guard";

// ---------------------------------------------------------------------------
// GraphQL – AST-based validation
// ---------------------------------------------------------------------------

describe("validateViewerGraphQL", () => {
  // ---- Valid queries ----

  it("allows a standard zone-scoped analytics query", () => {
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

  it("allows a named query operation", () => {
    const query = `query TrafficTimeSeries {
      viewer {
        zones(filter: { zoneTag: "abc" }) {
          httpRequestsAdaptiveGroups(limit: 100) {
            count
          }
        }
      }
    }`;
    expect(validateViewerGraphQL(query)).toBeNull();
  });

  it("allows an account-scoped gateway query", () => {
    const query = `{
      viewer {
        accounts(filter: { accountTag: "abc123def456abc123def456abc123de" }) {
          gatewayResolverQueriesAdaptiveGroups(
            limit: 1000
            filter: { datetime_geq: "2024-01-01T00:00:00Z" }
          ) {
            count
            dimensions { datetimeHour }
          }
        }
      }
    }`;
    expect(validateViewerGraphQL(query)).toBeNull();
  });

  it("allows batched (aliased) dataset queries under one zone", () => {
    const query = `{
      viewer {
        zones(filter: { zoneTag: "abc123" }) {
          threats: firewallEventsAdaptiveGroups(limit: 100, filter: { action: "block" }) {
            count
          }
          ddos: firewallEventsAdaptiveGroups(limit: 100, filter: { source: "l7ddos" }) {
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

  it("allows deeply nested result sub-fields (depth >= 3 is free)", () => {
    const query = `{
      viewer {
        zones(filter: { zoneTag: "x" }) {
          httpRequestsAdaptiveGroups(limit: 10) {
            count
            dimensions {
              datetimeHour
              cacheStatus
              clientCountryName
            }
            sum {
              edgeResponseBytes
            }
            avg {
              edgeTimeToFirstByteMs
            }
            quantiles {
              edgeTimeToFirstByteMsP50
              edgeTimeToFirstByteMsP95
            }
          }
        }
      }
    }`;
    expect(validateViewerGraphQL(query)).toBeNull();
  });

  // ---- Blocked: operation types ----

  it("rejects mutations", () => {
    const query = `mutation { deleteZone(id: "abc") { success } }`;
    expect(validateViewerGraphQL(query)).toBe('Operation type "mutation" is not allowed');
  });

  it("rejects subscriptions", () => {
    const query = `subscription { viewer { zones { httpRequestsAdaptiveGroups { count } } } }`;
    expect(validateViewerGraphQL(query)).toBe('Operation type "subscription" is not allowed');
  });

  it("rejects multiple operations", () => {
    const query = `
      query A { viewer { zones(filter: {zoneTag: "x"}) { httpRequestsAdaptiveGroups(limit:1) { count } } } }
      query B { viewer { zones(filter: {zoneTag: "y"}) { httpRequestsAdaptiveGroups(limit:1) { count } } } }
    `;
    expect(validateViewerGraphQL(query)).toBe("Only a single operation is allowed");
  });

  // ---- Blocked: introspection ----

  it("rejects __schema at root (caught by structural check)", () => {
    const query = `{ __schema { types { name } } }`;
    // Structural check catches it before introspection sweep: __schema is not "viewer"
    expect(validateViewerGraphQL(query)).toBe('Root field "__schema" is not allowed (must be "viewer")');
  });

  it("rejects __type under viewer (caught by scope check)", () => {
    const query = `{
      viewer {
        __type(name: "Zone") {
          fields { name }
        }
      }
    }`;
    // Structural check: __type is not "zones" or "accounts"
    expect(validateViewerGraphQL(query)).toBe('Field "__type" under viewer is not allowed (use "zones" or "accounts")');
  });

  it("rejects __schema hidden under an alias (caught by structural check)", () => {
    const query = `{ safe: __schema { types { name } } }`;
    // AST uses the real field name, not the alias
    expect(validateViewerGraphQL(query)).toBe('Root field "__schema" is not allowed (must be "viewer")');
  });

  it("rejects __schema deeply nested (caught by introspection sweep)", () => {
    // Even if someone tries to sneak introspection at depth ≥ 3 (where fields are free),
    // the global introspection sweep catches it
    const query = `{
      viewer {
        zones(filter: { zoneTag: "x" }) {
          httpRequestsAdaptiveGroups(limit: 1) {
            __schema { types { name } }
          }
        }
      }
    }`;
    expect(validateViewerGraphQL(query)).toBe("Introspection queries are not allowed");
  });

  // ---- Blocked: fragments ----

  it("rejects fragment definitions", () => {
    const query = `
      fragment Leak on Zone { __schema { types { name } } }
      { viewer { zones(filter:{zoneTag:"x"}) { httpRequestsAdaptiveGroups(limit:1) { count } } } }
    `;
    expect(validateViewerGraphQL(query)).toBe("Fragment definitions are not allowed");
  });

  it("rejects inline fragments", () => {
    const query = `{
      viewer {
        ... on Query {
          zones { httpRequestsAdaptiveGroups(limit:1) { count } }
        }
      }
    }`;
    expect(validateViewerGraphQL(query)).toBe("Inline fragments are not allowed");
  });

  it("rejects fragment spreads", () => {
    // This should fail at parse + fragment definition check
    const query = `
      fragment ZoneData on Zone { httpRequestsAdaptiveGroups(limit:1) { count } }
      { viewer { zones(filter:{zoneTag:"x"}) { ...ZoneData } } }
    `;
    expect(validateViewerGraphQL(query)).toBe("Fragment definitions are not allowed");
  });

  // ---- Blocked: structural violations ----

  it("rejects queries without viewer root", () => {
    const query = `{ zones { httpRequestsAdaptiveGroups(limit: 10) { count } } }`;
    expect(validateViewerGraphQL(query)).toBe('Root field "zones" is not allowed (must be "viewer")');
  });

  it("rejects non-scope fields under viewer", () => {
    const query = `{ viewer { users { name } } }`;
    expect(validateViewerGraphQL(query)).toBe('Field "users" under viewer is not allowed (use "zones" or "accounts")');
  });

  it("rejects unknown datasets under zones", () => {
    const query = `{
      viewer {
        zones(filter: { zoneTag: "x" }) {
          someUnknownDataset(limit: 10) { count }
        }
      }
    }`;
    expect(validateViewerGraphQL(query)).toBe('Dataset "someUnknownDataset" is not allowed');
  });

  it("rejects unknown datasets hidden with aliases", () => {
    // The alias is "safe" but the actual field is "dangerousDataset"
    const query = `{
      viewer {
        zones(filter: { zoneTag: "x" }) {
          safe: dangerousDataset(limit: 10) { count }
        }
      }
    }`;
    expect(validateViewerGraphQL(query)).toBe('Dataset "dangerousDataset" is not allowed');
  });

  it("rejects multiple root fields (extra fields alongside viewer)", () => {
    // GraphQL allows multiple root fields – we should reject anything besides viewer
    const query = `{
      viewer {
        zones(filter: { zoneTag: "x" }) {
          httpRequestsAdaptiveGroups(limit: 1) { count }
        }
      }
      other {
        secretData
      }
    }`;
    // "other" is not valid GraphQL field syntax that parses, but if it does parse,
    // it should be rejected. Let's test a realistic case:
    expect(validateViewerGraphQL(query)).not.toBeNull();
  });

  // ---- Blocked: size / format ----

  it("rejects oversized queries", () => {
    const query = "{ viewer { " + "x".repeat(4100) + " } }";
    expect(validateViewerGraphQL(query)).toBe("Query too large");
  });

  it("rejects empty/missing queries", () => {
    expect(validateViewerGraphQL("")).toBe("Missing query");
    expect(validateViewerGraphQL(null as unknown as string)).toBe("Missing query");
  });

  it("rejects syntactically invalid GraphQL", () => {
    const query = "{ viewer { zones { unclosed";
    const result = validateViewerGraphQL(query);
    expect(result).toMatch(/^Invalid GraphQL:/);
  });
});

// ---------------------------------------------------------------------------
// REST path validation (unchanged from previous)
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
