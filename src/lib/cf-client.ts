import type {
  CloudflareApiResponse,
  GraphQLResponse,
} from "@/types/cloudflare";

const CF_BASE = "https://api.cloudflare.com/client/v4";

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCacheKey(method: string, path: string, body?: string): string {
  return `${method}:${path}:${body || ""}`;
}

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 3
): Promise<Response> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const response = await fetch(url, init);

    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    return response;
  }

  throw new Error("Max retries exceeded for rate-limited request");
}

export class CloudflareClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private get headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  async rest<T>(
    path: string,
    options: { method?: string; body?: unknown; useCache?: boolean } = {}
  ): Promise<CloudflareApiResponse<T>> {
    const { method = "GET", body, useCache = true } = options;
    const url = `${CF_BASE}${path}`;
    const bodyStr = body ? JSON.stringify(body) : undefined;

    if (useCache && method === "GET") {
      const cacheKey = getCacheKey(method, path);
      const cached = getCached<CloudflareApiResponse<T>>(cacheKey);
      if (cached) return cached;
    }

    const response = await fetchWithRetry(url, {
      method,
      headers: this.headers,
      body: bodyStr,
    });

    const data = (await response.json()) as CloudflareApiResponse<T>;

    if (useCache && method === "GET" && data.success) {
      setCache(getCacheKey(method, path), data);
    }

    return data;
  }

  async restPaginated<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    const perPage = 50;

    while (true) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await this.rest<T[]>(
        `${path}${separator}page=${page}&per_page=${perPage}`,
        { useCache: false }
      );

      if (!response.success) break;

      results.push(...response.result);

      if (
        !response.result_info ||
        page >= response.result_info.total_pages
      ) {
        break;
      }
      page++;
    }

    return results;
  }

  async graphql<T = Record<string, unknown>>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<GraphQLResponse<T>> {
    const bodyStr = JSON.stringify({ query, variables });
    const cacheKey = getCacheKey("GRAPHQL", "/graphql", bodyStr);

    const cached = getCached<GraphQLResponse<T>>(cacheKey);
    if (cached) return cached;

    const response = await fetchWithRetry(`${CF_BASE}/graphql`, {
      method: "POST",
      headers: this.headers,
      body: bodyStr,
    });

    const data = (await response.json()) as GraphQLResponse<T>;

    if (!data.errors?.length) {
      setCache(cacheKey, data);
    }

    return data;
  }
}

export function clearCache(): void {
  cache.clear();
}
