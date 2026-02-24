import { createHash } from "crypto";
import type { TokenCapabilities } from "@/types/cloudflare";

interface CacheEntry {
  capabilities: TokenCapabilities;
  timestamp: number;
}

// In-memory cache keyed by a hash of the token (never store the token itself as a key)
const capabilitiesCache = new Map<string, CacheEntry>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Sweep expired entries periodically
const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of capabilitiesCache) {
    if (now - entry.timestamp > CACHE_TTL) {
      capabilitiesCache.delete(key);
    }
  }
}, 5 * 60_000); // every 5 minutes
sweepInterval.unref();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function setCapabilitiesCache(token: string, capabilities: TokenCapabilities): void {
  const key = hashToken(token);
  capabilitiesCache.set(key, { capabilities, timestamp: Date.now() });
}

export function getCapabilitiesCache(token: string): TokenCapabilities | null {
  const key = hashToken(token);
  const entry = capabilitiesCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    capabilitiesCache.delete(key);
    return null;
  }
  return entry.capabilities;
}
