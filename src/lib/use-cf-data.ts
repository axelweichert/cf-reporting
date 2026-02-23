"use client";

import { useState, useEffect, useCallback } from "react";

interface UseCfDataOptions<T> {
  fetcher: () => Promise<T>;
  deps?: unknown[];
}

interface UseCfDataResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useCfData<T>({ fetcher, deps = [] }: UseCfDataOptions<T>): UseCfDataResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetcher();
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch data");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}

// Helper: Call our CF proxy GraphQL endpoint
export async function cfGraphQL<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const res = await fetch("/api/cf/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors[0].message);
  }
  return json.data as T;
}

// Helper: Fetch Gateway category ID → name mapping (cached per account)
const categoryCache = new Map<string, Map<number, string>>();

export async function fetchCategoryMap(accountId: string): Promise<Map<number, string>> {
  if (categoryCache.has(accountId)) return categoryCache.get(accountId)!;

  try {
    const categories = await cfRest<Array<{
      id: number;
      name: string;
      subcategories?: Array<{ id: number; name: string; subcategories?: Array<{ id: number; name: string }> }>;
    }>>(`/accounts/${accountId}/gateway/categories`);

    const map = new Map<number, string>();
    for (const cat of categories) {
      map.set(cat.id, cat.name);
      for (const sub of cat.subcategories || []) {
        map.set(sub.id, sub.name);
        for (const sub2 of sub.subcategories || []) {
          map.set(sub2.id, sub2.name);
        }
      }
    }
    categoryCache.set(accountId, map);
    return map;
  } catch {
    return new Map();
  }
}

// Helper: Fetch Access app ID → name mapping (cached per account)
const appNameCache = new Map<string, Map<string, string>>();

export async function fetchAppNameMap(accountId: string): Promise<Map<string, string>> {
  if (appNameCache.has(accountId)) return appNameCache.get(accountId)!;

  try {
    const apps = await cfRestPaginated<{ id: string; name: string }>(
      `/accounts/${accountId}/access/apps`
    );

    const map = new Map<string, string>();
    for (const app of apps) {
      map.set(app.id, app.name);
    }
    appNameCache.set(accountId, map);
    return map;
  } catch {
    return new Map();
  }
}

// Helper: Fetch firewall rule ID → name mapping for a zone (cached)
const firewallRuleCache = new Map<string, Map<string, string>>();

export async function fetchFirewallRuleMap(zoneId: string): Promise<Map<string, string>> {
  if (firewallRuleCache.has(zoneId)) return firewallRuleCache.get(zoneId)!;

  const map = new Map<string, string>();

  // Fetch from multiple ruleset phases to cover WAF custom rules, managed rules, etc.
  const phases = [
    "http_request_firewall_custom",
    "http_request_firewall_managed",
    "http_request_sbfm",
    "http_ratelimit",
  ];

  const fetches = phases.map(async (phase) => {
    try {
      const ruleset = await cfRest<{
        id: string;
        name?: string;
        rules?: Array<{ id: string; description?: string; ref?: string; action?: string }>;
      }>(`/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`);

      for (const rule of ruleset.rules || []) {
        if (rule.description) {
          map.set(rule.id, rule.description);
        } else if (rule.ref) {
          map.set(rule.id, rule.ref);
        }
      }
    } catch {
      // Phase may not exist — ignore
    }
  });

  // Also fetch legacy firewall rules
  fetches.push(
    (async () => {
      try {
        const rules = await cfRest<Array<{ id: string; description?: string }>>(
          `/zones/${zoneId}/firewall/rules`
        );
        for (const rule of rules) {
          if (rule.description) {
            map.set(rule.id, rule.description);
          }
        }
      } catch {
        // Legacy endpoint may not be available
      }
    })()
  );

  await Promise.all(fetches);
  firewallRuleCache.set(zoneId, map);
  return map;
}

// Helper: Call our CF proxy REST endpoint
export async function cfRest<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`/api/cf${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  const json = await res.json();
  if (!json.success) {
    throw new Error(json.errors?.[0]?.message || "API request failed");
  }
  return json.result as T;
}

// Helper: Format country — handles both ISO codes ("US") and full names ("United States")
const countryDisplayNames = new Intl.DisplayNames(["en"], { type: "region" });

// Build reverse map: full name → code (e.g. "United States" → "US")
const nameToCode = new Map<string, string>();
for (let i = 65; i <= 90; i++) {
  for (let j = 65; j <= 90; j++) {
    const code = String.fromCharCode(i) + String.fromCharCode(j);
    try {
      const name = countryDisplayNames.of(code);
      if (name && name !== code) nameToCode.set(name.toLowerCase(), code);
    } catch { /* not a valid code */ }
  }
}

export function formatCountry(input: string): string {
  if (!input || input === "Unknown") return "Unknown";

  // If it's a 2-letter code, resolve to "Full Name (XX)"
  if (input.length === 2) {
    try {
      const name = countryDisplayNames.of(input.toUpperCase());
      return name && name !== input ? `${name} (${input.toUpperCase()})` : input;
    } catch {
      return input;
    }
  }

  // Otherwise it's a full name — look up the code
  const code = nameToCode.get(input.toLowerCase());
  return code ? `${input} (${code})` : input;
}

// Helper: Paginated REST fetch — auto-pages through all results
export async function cfRestPaginated<T = unknown>(path: string, perPage = 100): Promise<T[]> {
  const results: T[] = [];
  let page = 1;

  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const res = await fetch(`/api/cf${path}${separator}page=${page}&per_page=${perPage}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `API error: ${res.status}`);
    }
    const json = await res.json();
    if (!json.success) {
      throw new Error(json.errors?.[0]?.message || "API request failed");
    }

    const pageResults = json.result as T[];
    results.push(...pageResults);

    const info = json.result_info;
    if (!info || page >= info.total_pages || pageResults.length === 0) {
      break;
    }
    page++;
  }

  return results;
}
