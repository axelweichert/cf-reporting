"use client";

import { useState, useEffect, useCallback, useRef } from "react";

export type ErrorType = "permission" | "rate_limit" | "network" | "empty" | "generic";

interface UseCfDataOptions<T> {
  fetcher: () => Promise<T>;
  deps?: unknown[];
}

interface UseCfDataResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  errorType: ErrorType;
  refetch: () => void;
}

function classifyError(e: unknown): { message: string; type: ErrorType } {
  if (e instanceof CfApiError) {
    if (e.status === 403) return { message: e.message, type: "permission" };
    if (e.status === 429) return { message: e.message, type: "rate_limit" };
  }
  const msg = e instanceof Error ? e.message : "Failed to fetch data";
  if (msg.includes("403") || msg.toLowerCase().includes("permission") || msg.toLowerCase().includes("forbidden")) {
    return { message: msg, type: "permission" };
  }
  if (msg.includes("429") || msg.toLowerCase().includes("rate limit")) {
    return { message: msg, type: "rate_limit" };
  }
  if (msg.toLowerCase().includes("network") || msg.toLowerCase().includes("fetch")) {
    return { message: msg, type: "network" };
  }
  return { message: msg, type: "generic" };
}

export function useCfData<T>({ fetcher, deps = [] }: UseCfDataOptions<T>): UseCfDataResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorType, setErrorType] = useState<ErrorType>("generic");
  const reqId = useRef(0);

  const fetchData = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    setErrorType("generic");
    try {
      const result = await fetcher();
      if (id === reqId.current) setData(result);
    } catch (e) {
      if (id === reqId.current) {
        const classified = classifyError(e);
        setError(classified.message);
        setErrorType(classified.type);
      }
    } finally {
      if (id === reqId.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, errorType, refetch: fetchData };
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
      // Phase may not exist – ignore
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

// Custom error class that preserves HTTP status for permission detection
export class CfApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "CfApiError";
    this.status = status;
  }
}

// Helper: Call our CF proxy REST endpoint
export async function cfRest<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`/api/cf${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = body.errors?.[0]?.message || body.error || `API error: ${res.status}`;
    throw new CfApiError(message, res.status);
  }
  const json = await res.json();
  if (!json.success) {
    throw new Error(json.errors?.[0]?.message || "API request failed");
  }
  return json.result as T;
}

// Helper: Format country – handles both ISO codes ("US") and full names ("United States")
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

  // Otherwise it's a full name – look up the code
  const code = nameToCode.get(input.toLowerCase());
  return code ? `${input} (${code})` : input;
}

// Helper: Split a date range into daily chunks for GraphQL queries to avoid limit truncation
export function splitDateRange(since: string, until: string): Array<{ since: string; until: string }> {
  const start = new Date(since);
  const end = new Date(until);
  const chunks: Array<{ since: string; until: string }> = [];

  const current = new Date(start);
  while (current < end) {
    const chunkEnd = new Date(current);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    chunks.push({
      since: current.toISOString(),
      until: chunkEnd.toISOString(),
    });

    current.setUTCDate(current.getUTCDate() + 1);
  }

  return chunks;
}

// Helper: Fetch Cloudflare One / Zero Trust plan info (cached per account)
export interface ZtPlanInfo {
  planName: string;
  seatLimit: number;
  features: string[];
  isContract: boolean;
}

const planCache = new Map<string, ZtPlanInfo>();

export async function fetchZtPlanInfo(accountId: string): Promise<ZtPlanInfo | null> {
  if (planCache.has(accountId)) return planCache.get(accountId)!;

  try {
    const subs = await cfRest<Array<{
      rate_plan: { id: string; public_name: string; is_contract: boolean };
      component_values: Array<{ name: string; value: number }>;
    }>>(`/accounts/${accountId}/subscriptions`);

    const ztSub = subs.find((s) =>
      s.rate_plan.id.startsWith("teams_") || s.rate_plan.public_name.toLowerCase().includes("zero trust")
    );
    if (!ztSub) return null;

    const seatLimit = ztSub.component_values.find((c) => c.name === "users")?.value || 0;

    const featureMap: Record<string, string> = {
      browser_isolation_adv: "Browser Isolation",
      dlp: "DLP",
      casb: "CASB",
      dex: "DEX",
    };
    const features = ztSub.component_values
      .filter((c) => c.name !== "users" && c.value > 0 && featureMap[c.name])
      .map((c) => featureMap[c.name]);

    const info: ZtPlanInfo = {
      planName: ztSub.rate_plan.public_name,
      seatLimit,
      features,
      isContract: ztSub.rate_plan.is_contract,
    };
    planCache.set(accountId, info);
    return info;
  } catch {
    return null;
  }
}

export async function cfRestPaginated<T = unknown>(path: string, perPage = 100): Promise<T[]> {
  const results: T[] = [];
  let page = 1;

  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const res = await fetch(`/api/cf${path}${separator}page=${page}&per_page=${perPage}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = body.errors?.[0]?.message || body.error || `API error: ${res.status}`;
      throw new CfApiError(message, res.status);
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
