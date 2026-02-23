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
