/**
 * Scheduled data collector – dataset-oriented raw data lake.
 *
 * Fetches each Cloudflare GraphQL dataset ONCE per zone/account, stores raw
 * data in flexible dimension tables, and derives all reports from SQL at read time.
 *
 * Zone datasets:    http, http_overview, firewall, dns, health + REST snapshots
 * Account datasets: gw-dns, gw-net, gw-http, access, dosd + REST snapshots
 *
 * Initial backfill: On the very first run (no stored data), the collector
 * fetches historical data day-by-day going back up to N days, based on
 * the highest Cloudflare plan detected:
 *   - Free:              3 days
 *   - Pro / Business:   30 days
 *   - Enterprise:       90 days
 * Override with INITIAL_LOOKBACK_DAYS env var (1–365).
 *
 * Throttling: A 2-second pause is inserted between each day-slice during
 * backfill to stay well within Cloudflare's 1200 req / 5 min rate limit.
 *
 * Requires CF_API_TOKEN + writable SQLite database.
 */

import { randomUUID } from "crypto";
import cron, { type ScheduledTask } from "node-cron";
import { CloudflareClient } from "@/lib/cf-client";
import { discoverZones, discoverAccounts } from "@/lib/token";
import type { CloudflareZone } from "@/types/cloudflare";

// Dataset names for collection_log entries
const ZONE_DATASETS = ["http", "firewall", "dns", "health"] as const;
const ACCOUNT_DATASETS = ["gw-dns", "gw-net", "gw-http", "access", "dosd"] as const;

// All report types (for getCollectorStatus – preserves UI compatibility)
const ZONE_REPORT_TYPES = [
  "executive", "security", "traffic", "performance", "dns",
  "origin-health", "ssl", "bots", "ddos", "api-shield",
] as const;
const ACCOUNT_REPORT_TYPES = [
  "gateway-dns", "gateway-network", "shadow-it",
  "devices-users", "zt-summary", "access-audit",
] as const;

// Delay between daily backfill slices (ms)
const BACKFILL_DELAY_MS = 2_000;

/** Detect Cloudflare permission / plan-gated errors that should be "skipped" not "error". */
function isPermissionError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("does not have access") ||
    lower.includes("not entitled") ||
    lower.includes("not allowed") ||
    lower.includes("permission denied") ||
    lower.includes("insufficient permissions") ||
    lower.includes("requires a higher plan") ||
    lower.includes("upgrade your plan") ||
    lower.includes("not available on your plan") ||
    lower.includes("not available for free") ||
    lower.includes("access denied") ||
    /\b(403|10000)\b/.test(message)
  );
}

/**
 * Determine initial lookback days based on the highest plan among all zones.
 */
function detectLookbackDays(zones: CloudflareZone[]): number {
  const envOverride = process.env.INITIAL_LOOKBACK_DAYS;
  if (envOverride) {
    const parsed = parseInt(envOverride, 10);
    if (!isNaN(parsed) && parsed >= 1) return Math.min(parsed, 365);
  }

  let maxTier = 0; // 0=free, 1=pro, 2=business, 3=enterprise
  for (const zone of zones) {
    const plan = zone.plan.name.toLowerCase();
    if (plan.includes("enterprise")) { maxTier = Math.max(maxTier, 3); }
    else if (plan.includes("business")) { maxTier = Math.max(maxTier, 2); }
    else if (plan.includes("pro")) { maxTier = Math.max(maxTier, 1); }
  }

  if (maxTier >= 3) return 90;
  if (maxTier >= 1) return 30;
  return 3;
}

let _running = false;
let _lastRunAt: string | null = null;
let _lastRunStatus: "success" | "partial" | "error" | null = null;
let _nextRunAt: string | null = null;
let _cronTask: ScheduledTask | null = null;
let _dbAvailable: boolean | null = null;

/** Try to initialize SQLite lazily – returns true if available. */
function checkDb(): boolean {
  if (_dbAvailable !== null) return _dbAvailable;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isDbAvailable } = require("@/lib/db") as { isDbAvailable: () => boolean };
    _dbAvailable = isDbAvailable();
  } catch {
    _dbAvailable = false;
  }
  return _dbAvailable;
}

/** Lazy-load data store tracking helpers. */
function getStore() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/data-store") as typeof import("@/lib/data-store");
}

/** Lazy-load raw fetchers. */
function getRawFetchers() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/collector/raw-fetchers") as typeof import("@/lib/collector/raw-fetchers");
}

/** Lazy-load raw store. */
function getRawStore() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/collector/raw-store") as typeof import("@/lib/collector/raw-store");
}

/** Lazy-load zone-scoped REST snapshot fetchers. */
function getReportDataZone() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/email/report-data-zone") as typeof import("@/lib/email/report-data-zone");
}

/** Lazy-load account-scoped REST snapshot fetchers. */
function getReportDataZt() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/email/report-data-zt") as typeof import("@/lib/email/report-data-zt");
}

/** Lazy-load zone-scoped REST snapshot fetchers (report-data). */
function getReportData() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/email/report-data") as typeof import("@/lib/email/report-data");
}

export function initCollector(): void {
  const token = process.env.CF_API_TOKEN;
  if (!token) {
    console.log("[collector] No CF_API_TOKEN set – data collection disabled");
    return;
  }

  if (!checkDb()) {
    console.log("[collector] SQLite unavailable – data collection disabled");
    return;
  }

  const schedule = process.env.COLLECTION_SCHEDULE || "0 */6 * * *";

  if (!cron.validate(schedule)) {
    console.error(`[collector] Invalid COLLECTION_SCHEDULE: "${schedule}" – using default`);
    _cronTask = cron.schedule("0 */6 * * *", () => runCollection());
  } else {
    _cronTask = cron.schedule(schedule, () => runCollection());
  }

  console.log(`[collector] Scheduled data collection: ${schedule}`);

  // Initial collection 10s after startup
  setTimeout(() => runCollection(), 10_000);
}

/** Sleep helper for throttling. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build an array of { since, until } day-slices from oldest to newest.
 */
function buildDaySlices(since: Date, until: Date): Array<{ since: string; until: string }> {
  const slices: Array<{ since: string; until: string }> = [];
  const cursor = new Date(since);
  while (cursor < until) {
    const dayEnd = new Date(cursor);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    if (dayEnd > until) dayEnd.setTime(until.getTime());
    slices.push({ since: cursor.toISOString(), until: dayEnd.toISOString() });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return slices;
}

export async function runCollection(): Promise<void> {
  if (_running) {
    console.log("[collector] Collection already in progress, skipping");
    return;
  }

  const token = process.env.CF_API_TOKEN;
  if (!token) return;

  const store = getStore();
  const rawStore = getRawStore();

  _running = true;
  const runId = randomUUID();
  const startTime = Date.now();
  let errorCount = 0;
  let successCount = 0;
  let skippedCount = 0;

  console.log(`[collector] Starting collection run ${runId}`);

  try {
    const client = new CloudflareClient(token);
    const [zones, accounts] = await Promise.all([
      discoverZones(client),
      discoverAccounts(client),
    ]);

    if (zones.length === 0 && accounts.length === 0) {
      console.warn("[collector] No zones or accounts discovered – check token permissions");
      _lastRunStatus = "error";
      _lastRunAt = new Date().toISOString();
      return;
    }

    console.log(`[collector] Discovered ${zones.length} zone(s), ${accounts.length} account(s)`);

    store.startCollectionRun(runId, zones.length, accounts.length);

    const now = new Date();
    const lookbackDays = detectLookbackDays(zones);
    const OVERLAP_MS = 60 * 60 * 1000;

    // Determine per-scope since/until based on last timestamp
    type ScopeWork = {
      id: string;
      name: string;
      type: "zone" | "account";
      fetchSince: string;
      isBackfill: boolean;
    };

    const allWork: ScopeWork[] = [];
    let hasBackfill = false;

    for (const zone of zones) {
      const lastTs = rawStore.getZoneLastTimestamp(zone.id);
      if (lastTs) {
        const overlapped = new Date(new Date(lastTs * 1000).getTime() - OVERLAP_MS);
        allWork.push({ id: zone.id, name: zone.name, type: "zone", fetchSince: overlapped.toISOString(), isBackfill: false });
      } else {
        hasBackfill = true;
        const since = new Date(now);
        since.setDate(since.getDate() - lookbackDays);
        allWork.push({ id: zone.id, name: zone.name, type: "zone", fetchSince: since.toISOString(), isBackfill: true });
      }
    }

    for (const account of accounts) {
      const lastTs = rawStore.getAccountLastTimestamp(account.id);
      if (lastTs) {
        const overlapped = new Date(new Date(lastTs * 1000).getTime() - OVERLAP_MS);
        allWork.push({ id: account.id, name: account.name, type: "account", fetchSince: overlapped.toISOString(), isBackfill: false });
      } else {
        hasBackfill = true;
        const since = new Date(now);
        since.setDate(since.getDate() - lookbackDays);
        allWork.push({ id: account.id, name: account.name, type: "account", fetchSince: since.toISOString(), isBackfill: true });
      }
    }

    // Process incremental work (small ranges, no throttling needed)
    const incrementalWork = allWork.filter((w) => !w.isBackfill);
    for (const work of incrementalWork) {
      const result = await collectScope(
        client, token, runId, work, now.toISOString(), store, rawStore,
      );
      successCount += result.success;
      errorCount += result.error;
      skippedCount += result.skipped;
    }

    // Process backfill work day-by-day with throttling
    if (hasBackfill) {
      const backfillWork = allWork.filter((w) => w.isBackfill);
      const earliestSince = new Date(Math.min(
        ...backfillWork.map((w) => new Date(w.fetchSince).getTime()),
      ));
      const daySlices = buildDaySlices(earliestSince, now);

      console.log(`[collector] Backfill: ${lookbackDays} days (${daySlices.length} slices) for ${backfillWork.length} scope(s)`);

      for (let i = 0; i < daySlices.length; i++) {
        const slice = daySlices[i];
        const dayLabel = slice.since.slice(0, 10);

        for (const work of backfillWork) {
          const dayWork = { ...work, fetchSince: slice.since };
          const result = await collectScope(
            client, token, runId, dayWork, slice.until, store, rawStore,
            `backfill ${dayLabel}`,
          );
          successCount += result.success;
          errorCount += result.error;
          skippedCount += result.skipped;
        }

        if (i < daySlices.length - 1) {
          await sleep(BACKFILL_DELAY_MS);
        }
      }
    }

    _lastRunStatus = errorCount === 0 ? "success" : "partial";
  } catch (err) {
    console.error("[collector] Collection run failed:", err instanceof Error ? err.message : err);
    _lastRunStatus = "error";
  } finally {
    _running = false;
    _lastRunAt = new Date().toISOString();
    const totalDuration = Date.now() - startTime;

    const store = getStore();
    const finalStatus = _lastRunStatus || "error";
    store.finishCollectionRun(runId, finalStatus, successCount, errorCount, skippedCount);

    console.log(`[collector] Run ${runId} complete: ${successCount} success, ${errorCount} errors, ${skippedCount} skipped (${totalDuration}ms)`);
  }
}


// =============================================================================
// Per-scope collection
// =============================================================================

type CollectResult = { success: number; error: number; skipped: number };

async function collectScope(
  client: CloudflareClient,
  token: string,
  runId: string,
  work: { id: string; name: string; type: "zone" | "account"; fetchSince: string },
  until: string,
  store: ReturnType<typeof getStore>,
  rawStore: ReturnType<typeof getRawStore>,
  labelOverride?: string,
): Promise<CollectResult> {
  if (work.type === "zone") {
    return collectZone(client, token, runId, work, until, store, rawStore, labelOverride);
  } else {
    return collectAccount(client, token, runId, work, until, store, rawStore, labelOverride);
  }
}

async function collectZone(
  client: CloudflareClient,
  token: string,
  runId: string,
  work: { id: string; name: string; fetchSince: string },
  until: string,
  store: ReturnType<typeof getStore>,
  rawStore: ReturnType<typeof getRawStore>,
  labelOverride?: string,
): Promise<CollectResult> {
  const label = labelOverride ?? "incremental";
  let success = 0;
  let error = 0;
  let skipped = 0;

  // Fetch all GraphQL datasets
  const fetchStart = Date.now();
  try {
    const fetchers = getRawFetchers();
    const rawData = await fetchers.fetchAllZoneData(client, work.id, work.fetchSince, until);

    // Store raw data
    rawStore.storeRawZoneData(work.id, rawData);

    const duration = Date.now() - fetchStart;

    // Log each dataset individually
    for (const ds of ZONE_DATASETS) {
      const hasData = ds === "http" ? rawData.http !== null
        : ds === "firewall" ? rawData.firewall !== null
        : ds === "dns" ? rawData.dns !== null
        : rawData.health !== null;

      if (hasData) {
        store.logCollectionItem(runId, work.id, work.name, ds, "success", duration);
        success++;
      } else {
        store.logCollectionItem(runId, work.id, work.name, ds, "skipped", duration, "Dataset returned null (permission or no data)");
        skipped++;
      }
    }

    console.log(`[collector] ${work.name} / zone-datasets – OK (${duration}ms) [${label}]`);
  } catch (err) {
    const duration = Date.now() - fetchStart;
    const message = err instanceof Error ? err.message : "Unknown error";

    if (isPermissionError(message)) {
      for (const ds of ZONE_DATASETS) {
        store.logCollectionItem(runId, work.id, work.name, ds, "skipped", duration, message);
        skipped++;
      }
      console.log(`[collector] ${work.name} / zone-datasets – SKIPPED (${duration}ms) [permission]`);
    } else {
      for (const ds of ZONE_DATASETS) {
        store.logCollectionItem(runId, work.id, work.name, ds, "error", duration, message);
        error++;
      }
      console.error(`[collector] ${work.name} / zone-datasets – ERROR: ${message}`);
    }
  }

  // Fetch REST snapshots (these remain unchanged)
  const restResult = await collectZoneRestSnapshots(token, runId, work, until, store);
  success += restResult.success;
  error += restResult.error;
  skipped += restResult.skipped;

  return { success, error, skipped };
}

async function collectAccount(
  client: CloudflareClient,
  token: string,
  runId: string,
  work: { id: string; name: string; fetchSince: string },
  until: string,
  store: ReturnType<typeof getStore>,
  rawStore: ReturnType<typeof getRawStore>,
  labelOverride?: string,
): Promise<CollectResult> {
  const label = labelOverride ?? "incremental";
  let success = 0;
  let error = 0;
  let skipped = 0;

  // Fetch all GraphQL datasets
  const fetchStart = Date.now();
  try {
    const fetchers = getRawFetchers();
    const rawData = await fetchers.fetchAllAccountData(client, work.id, work.fetchSince, until);

    // Store raw data
    rawStore.storeRawAccountData(work.id, rawData);

    const duration = Date.now() - fetchStart;

    // Log each dataset individually
    for (const ds of ACCOUNT_DATASETS) {
      const hasData = ds === "gw-dns" ? rawData.gwDns !== null
        : ds === "gw-net" ? rawData.gwNet !== null
        : ds === "gw-http" ? rawData.gwHttp !== null
        : ds === "access" ? rawData.access !== null
        : rawData.dosd !== null;

      if (hasData) {
        store.logCollectionItem(runId, work.id, work.name, ds, "success", duration);
        success++;
      } else {
        store.logCollectionItem(runId, work.id, work.name, ds, "skipped", duration, "Dataset returned null (permission or no data)");
        skipped++;
      }
    }

    console.log(`[collector] ${work.name} / account-datasets – OK (${duration}ms) [${label}]`);
  } catch (err) {
    const duration = Date.now() - fetchStart;
    const message = err instanceof Error ? err.message : "Unknown error";

    if (isPermissionError(message)) {
      for (const ds of ACCOUNT_DATASETS) {
        store.logCollectionItem(runId, work.id, work.name, ds, "skipped", duration, message);
        skipped++;
      }
      console.log(`[collector] ${work.name} / account-datasets – SKIPPED (${duration}ms) [permission]`);
    } else {
      for (const ds of ACCOUNT_DATASETS) {
        store.logCollectionItem(runId, work.id, work.name, ds, "error", duration, message);
        error++;
      }
      console.error(`[collector] ${work.name} / account-datasets – ERROR: ${message}`);
    }
  }

  // Fetch REST snapshots (devices, users, posture, access apps)
  const restResult = await collectAccountRestSnapshots(token, runId, work, store);
  success += restResult.success;
  error += restResult.error;
  skipped += restResult.skipped;

  return { success, error, skipped };
}


// =============================================================================
// REST snapshot collection (kept from v4 – unchanged data shapes)
// =============================================================================

async function collectZoneRestSnapshots(
  token: string,
  runId: string,
  work: { id: string; name: string; fetchSince: string },
  until: string,
  store: ReturnType<typeof getStore>,
): Promise<CollectResult> {
  let success = 0;
  let error = 0;
  let skipped = 0;

  // DNS records, SSL certs/settings, health checks – these go into kept v4 tables
  const restSnapshotTypes = [
    { type: "dns-records", fn: async () => {
      const m = getReportData();
      return m.fetchDnsDataServer(token, work.id, work.fetchSince, until);
    }},
    { type: "ssl-snapshots", fn: async () => {
      const m = getReportDataZone();
      return m.fetchSslDataServer(token, work.id, work.fetchSince, until);
    }},
    { type: "origin-health-snapshots", fn: async () => {
      const m = getReportDataZone();
      return m.fetchOriginHealthDataServer(token, work.id, work.fetchSince, until);
    }},
    { type: "api-shield-snapshots", fn: async () => {
      const m = getReportDataZone();
      return m.fetchApiShieldDataServer(token, work.id, work.fetchSince, until);
    }},
  ];

  for (const snap of restSnapshotTypes) {
    const fetchStart = Date.now();
    try {
      const data = await snap.fn();
      const collectedAt = Math.floor(Date.now() / 1000);
      store.storeReportData(work.id, work.name, snap.type, collectedAt, data);
      const duration = Date.now() - fetchStart;
      store.logCollectionItem(runId, work.id, work.name, snap.type, "success", duration);
      success++;
    } catch (err) {
      const duration = Date.now() - fetchStart;
      const message = err instanceof Error ? err.message : "Unknown error";
      if (isPermissionError(message)) {
        store.logCollectionItem(runId, work.id, work.name, snap.type, "skipped", duration, message);
        skipped++;
      } else {
        store.logCollectionItem(runId, work.id, work.name, snap.type, "error", duration, message);
        error++;
      }
    }
  }

  return { success, error, skipped };
}

async function collectAccountRestSnapshots(
  token: string,
  runId: string,
  work: { id: string; name: string },
  store: ReturnType<typeof getStore>,
): Promise<CollectResult> {
  let success = 0;
  let error = 0;
  let skipped = 0;

  const restSnapshotTypes = [
    { type: "devices-users", fn: async () => {
      const m = getReportDataZt();
      return m.fetchDevicesUsersDataServer(token, work.id);
    }},
  ];

  for (const snap of restSnapshotTypes) {
    const fetchStart = Date.now();
    try {
      const data = await snap.fn();
      const collectedAt = Math.floor(Date.now() / 1000);
      store.storeReportData(work.id, work.name, snap.type, collectedAt, data);
      const duration = Date.now() - fetchStart;
      store.logCollectionItem(runId, work.id, work.name, snap.type, "success", duration);
      success++;
    } catch (err) {
      const duration = Date.now() - fetchStart;
      const message = err instanceof Error ? err.message : "Unknown error";
      if (isPermissionError(message)) {
        store.logCollectionItem(runId, work.id, work.name, snap.type, "skipped", duration, message);
        skipped++;
      } else {
        store.logCollectionItem(runId, work.id, work.name, snap.type, "error", duration, message);
        error++;
      }
    }
  }

  return { success, error, skipped };
}


// =============================================================================
// Public API
// =============================================================================

export function getCollectorStatus() {
  // Derive running state from DB to work across Next.js workers
  let dbRunning = false;
  let dbLastRunAt: number | null = null;
  let dbLastRunStatus: string | null = null;
  try {
    const store = getStore();
    const runs = store.getRecentCollectionRuns(1);
    if (runs.length > 0) {
      const latest = runs[0];
      dbRunning = latest.status === "running" && latest.finished_at === null;
      dbLastRunAt = latest.finished_at ?? latest.started_at;
      dbLastRunStatus = latest.status;
    }
  } catch { /* db unavailable */ }

  return {
    enabled: !!process.env.CF_API_TOKEN && checkDb(),
    running: _running || dbRunning,
    lastRunAt: dbLastRunAt,
    lastRunStatus: dbLastRunStatus ?? _lastRunStatus,
    nextRunAt: _nextRunAt,
    schedule: process.env.COLLECTION_SCHEDULE || "0 */6 * * *",
    zoneReportTypes: ZONE_REPORT_TYPES,
    accountReportTypes: ACCOUNT_REPORT_TYPES,
    totalReportTypes: ZONE_REPORT_TYPES.length + ACCOUNT_REPORT_TYPES.length,
  };
}

export function stopCollector(): void {
  if (_cronTask) {
    _cronTask.stop();
    _cronTask = null;
  }
}
