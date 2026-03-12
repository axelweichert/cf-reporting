import { createHash } from "crypto";
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
const MAX_CACHE_ENTRIES = 500;

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function getCacheKey(scope: string, method: string, path: string, body?: string): string {
  return `${scope}:${method}:${path}:${body || ""}`;
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > CACHE_TTL) {
      cache.delete(key);
    }
  }
}

// Sweep expired entries every 60 seconds
const sweepInterval = setInterval(sweepExpired, 60_000);
sweepInterval.unref(); // Don't prevent process exit

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
  // Evict oldest entries if at capacity
  if (cache.size >= MAX_CACHE_ENTRIES) {
    sweepExpired();
    // Still over limit – drop oldest entries
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const toDelete = cache.size - MAX_CACHE_ENTRIES + 1;
      const iter = cache.keys();
      for (let i = 0; i < toDelete; i++) {
        const { value } = iter.next();
        if (value) cache.delete(value);
      }
    }
  }
  cache.set(key, { data, timestamp: Date.now() });
}

const FETCH_TIMEOUT_MS = 30_000; // 30 seconds per request

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 3
): Promise<Response> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      return response;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("Max retries exceeded for rate-limited request");
}

export class CloudflareClient {
  private token: string;
  private scope: string;

  constructor(token: string) {
    this.token = token;
    this.scope = tokenFingerprint(token);
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
  ): Promise<CloudflareApiResponse<T> & { _httpStatus?: number }> {
    const { method = "GET", body, useCache = true } = options;
    const url = `${CF_BASE}${path}`;
    const bodyStr = body ? JSON.stringify(body) : undefined;

    if (useCache && method === "GET") {
      const cacheKey = getCacheKey(this.scope, method, path);
      const cached = getCached<CloudflareApiResponse<T>>(cacheKey);
      if (cached) return cached;
    }

    const response = await fetchWithRetry(url, {
      method,
      headers: this.headers,
      body: bodyStr,
    });

    const data = (await response.json()) as CloudflareApiResponse<T> & { _httpStatus?: number };
    data._httpStatus = response.status;

    if (useCache && method === "GET" && data.success) {
      setCache(getCacheKey(this.scope, method, path), data);
    }

    return data;
  }

  async restPaginated<T>(path: string, maxPages = 100): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    const perPage = 50;

    while (page <= maxPages) {
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
    const cacheKey = getCacheKey(this.scope, "GRAPHQL", "/graphql", bodyStr);

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
