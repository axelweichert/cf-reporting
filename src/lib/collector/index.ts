/**
 * Scheduled data collector – fetches all 16 report types for every zone
 * and account, then stores data in normalized SQLite tables.
 *
 * Zone-scoped (10): executive, security, traffic, performance, dns,
 *                   origin-health, ssl, bots, api-shield, ddos
 * Account-scoped (6): gateway-dns, gateway-network, shadow-it,
 *                     devices-users, zt-summary, access-audit
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

type ZoneReportType =
  | "executive"
  | "security"
  | "traffic"
  | "performance"
  | "dns"
  | "origin-health"
  | "ssl"
  | "bots"
  | "api-shield"
  | "ddos";

type AccountReportType =
  | "gateway-dns"
  | "gateway-network"
  | "shadow-it"
  | "devices-users"
  | "zt-summary"
  | "access-audit";

const ZONE_REPORT_TYPES: ZoneReportType[] = [
  "executive", "security", "traffic", "performance", "dns",
  "origin-health", "ssl", "bots", "ddos", "api-shield",
];

const ACCOUNT_REPORT_TYPES: AccountReportType[] = [
  "gateway-dns", "gateway-network", "shadow-it",
  "devices-users", "zt-summary", "access-audit",
];

// Delay between daily backfill slices (ms) – keeps us well under rate limits
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
 * Cloudflare analytics data retention varies by plan:
 *   Free       –  limited retention, ~3 days of adaptive data
 *   Pro / Biz  – ~30 days
 *   Enterprise – ~90 days
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

/** Lazy-load normalized data store helpers. */
function getStore() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/data-store") as typeof import("@/lib/data-store");
}

/** Lazy-load zone-scoped report data fetchers (original 5). */
function getReportData() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/email/report-data") as typeof import("@/lib/email/report-data");
}

/** Lazy-load zone-scoped report data fetchers (new 5). */
function getReportDataZone() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/email/report-data-zone") as typeof import("@/lib/email/report-data-zone");
}

/** Lazy-load account-scoped (Zero Trust) report data fetchers. */
function getReportDataZt() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/email/report-data-zt") as typeof import("@/lib/email/report-data-zt");
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
 * Each slice covers exactly one UTC day (or the remainder for the last slice).
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
    const nowStr = now.toISOString();
    const lookbackDays = detectLookbackDays(zones);
    // Overlap buffer: 1 hour back from last period_end to avoid gaps
    const OVERLAP_MS = 60 * 60 * 1000;

    // --- Determine which scopes need backfill vs. incremental ---
    // A scope/reportType needs backfill if getLastTimestamp returns null.
    // We collect all backfill needs first, then process day-by-day.

    type ScopeWork = {
      id: string;
      name: string;
      reportType: string;
      fetchSince: string;
      isBackfill: boolean;
    };

    const zoneWork: ScopeWork[] = [];
    const accountWork: ScopeWork[] = [];

    let hasBackfill = false;

    for (const zone of zones) {
      for (const reportType of ZONE_REPORT_TYPES) {
        const lastTs = store.getLastTimestamp(zone.id, reportType);
        if (lastTs) {
          const overlapped = new Date(new Date(lastTs * 1000).getTime() - OVERLAP_MS);
          zoneWork.push({
            id: zone.id, name: zone.name, reportType,
            fetchSince: overlapped.toISOString(), isBackfill: false,
          });
        } else {
          hasBackfill = true;
          const since = new Date(now);
          since.setDate(since.getDate() - lookbackDays);
          zoneWork.push({
            id: zone.id, name: zone.name, reportType,
            fetchSince: since.toISOString(), isBackfill: true,
          });
        }
      }
    }

    for (const account of accounts) {
      for (const reportType of ACCOUNT_REPORT_TYPES) {
        const lastTs = store.getLastTimestamp(account.id, reportType);
        if (lastTs) {
          const overlapped = new Date(new Date(lastTs * 1000).getTime() - OVERLAP_MS);
          accountWork.push({
            id: account.id, name: account.name, reportType,
            fetchSince: overlapped.toISOString(), isBackfill: false,
          });
        } else {
          hasBackfill = true;
          const since = new Date(now);
          since.setDate(since.getDate() - lookbackDays);
          accountWork.push({
            id: account.id, name: account.name, reportType,
            fetchSince: since.toISOString(), isBackfill: true,
          });
        }
      }
    }

    // --- Process incremental work (small ranges, no throttling needed) ---
    const incrementalZone = zoneWork.filter((w) => !w.isBackfill);
    const incrementalAccount = accountWork.filter((w) => !w.isBackfill);

    for (const work of incrementalZone) {
      const result = await collectZoneReport(
        token, runId, work, nowStr, accounts[0]?.id, store,
      );
      successCount += result.success;
      errorCount += result.error;
      skippedCount += result.skipped;
    }

    for (const work of incrementalAccount) {
      const result = await collectAccountReport(token, runId, work, nowStr, store);
      successCount += result.success;
      errorCount += result.error;
      skippedCount += result.skipped;
    }

    // --- Process backfill work day-by-day with throttling ---
    if (hasBackfill) {
      const backfillZone = zoneWork.filter((w) => w.isBackfill);
      const backfillAccount = accountWork.filter((w) => w.isBackfill);

      // Find the earliest backfill start
      const earliestSince = new Date(Math.min(
        ...backfillZone.map((w) => new Date(w.fetchSince).getTime()),
        ...backfillAccount.map((w) => new Date(w.fetchSince).getTime()),
      ));
      const daySlices = buildDaySlices(earliestSince, now);

      console.log(`[collector] Backfill: ${lookbackDays} days (${daySlices.length} slices) for ${backfillZone.length + backfillAccount.length} scope/report combos`);

      for (let i = 0; i < daySlices.length; i++) {
        const slice = daySlices[i];
        const dayLabel = slice.since.slice(0, 10);

        // Collect all backfill scopes for this day-slice
        for (const work of backfillZone) {
          const dayWork = { ...work, fetchSince: slice.since };
          const result = await collectZoneReport(
            token, runId, dayWork, slice.until, accounts[0]?.id, store,
            `backfill ${dayLabel}`,
          );
          successCount += result.success;
          errorCount += result.error;
          skippedCount += result.skipped;
        }

        for (const work of backfillAccount) {
          const dayWork = { ...work, fetchSince: slice.since };
          const result = await collectAccountReport(
            token, runId, dayWork, slice.until, store,
            `backfill ${dayLabel}`,
          );
          successCount += result.success;
          errorCount += result.error;
          skippedCount += result.skipped;
        }

        // Throttle between day-slices (skip delay after the last slice)
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

// --- Per-scope collection helpers ---

type CollectResult = { success: number; error: number; skipped: number };

async function collectZoneReport(
  token: string,
  runId: string,
  work: { id: string; name: string; reportType: string; fetchSince: string },
  until: string,
  accountId: string | undefined,
  store: ReturnType<typeof getStore>,
  labelOverride?: string,
): Promise<CollectResult> {
  const fetchStart = Date.now();
  try {
    const data = await fetchZoneReportData(
      token, work.id, work.fetchSince, until,
      work.reportType as ZoneReportType, accountId,
    );

    const collectedAt = Math.floor(Date.now() / 1000);
    store.storeReportData(work.id, work.name, work.reportType, collectedAt, data);
    const duration = Date.now() - fetchStart;
    store.logCollectionItem(runId, work.id, work.name, work.reportType, "success", duration);
    const label = labelOverride ?? "incremental";
    console.log(`[collector] ${work.name} / ${work.reportType} – OK (${duration}ms) [${label}]`);
    return { success: 1, error: 0, skipped: 0 };
  } catch (err) {
    const duration = Date.now() - fetchStart;
    const message = err instanceof Error ? err.message : "Unknown error";
    if (isPermissionError(message)) {
      store.logCollectionItem(runId, work.id, work.name, work.reportType, "skipped", duration, message);
      console.log(`[collector] ${work.name} / ${work.reportType} – SKIPPED (${duration}ms) [permission]`);
      return { success: 0, error: 0, skipped: 1 };
    }
    store.logCollectionItem(runId, work.id, work.name, work.reportType, "error", duration, message);
    console.error(`[collector] ${work.name} / ${work.reportType} – ERROR: ${message}`);
    return { success: 0, error: 1, skipped: 0 };
  }
}

async function collectAccountReport(
  token: string,
  runId: string,
  work: { id: string; name: string; reportType: string; fetchSince: string },
  until: string,
  store: ReturnType<typeof getStore>,
  labelOverride?: string,
): Promise<CollectResult> {
  const fetchStart = Date.now();
  try {
    const data = await fetchAccountReportData(
      token, work.id, work.fetchSince, until,
      work.reportType as AccountReportType,
    );

    const collectedAt = Math.floor(Date.now() / 1000);
    store.storeReportData(work.id, work.name, work.reportType, collectedAt, data);
    const duration = Date.now() - fetchStart;
    store.logCollectionItem(runId, work.id, work.name, work.reportType, "success", duration);
    const label = labelOverride ?? "incremental";
    console.log(`[collector] ${work.name} / ${work.reportType} – OK (${duration}ms) [${label}]`);
    return { success: 1, error: 0, skipped: 0 };
  } catch (err) {
    const duration = Date.now() - fetchStart;
    const message = err instanceof Error ? err.message : "Unknown error";
    if (isPermissionError(message)) {
      store.logCollectionItem(runId, work.id, work.name, work.reportType, "skipped", duration, message);
      console.log(`[collector] ${work.name} / ${work.reportType} – SKIPPED (${duration}ms) [permission]`);
      return { success: 0, error: 0, skipped: 1 };
    }
    store.logCollectionItem(runId, work.id, work.name, work.reportType, "error", duration, message);
    console.error(`[collector] ${work.name} / ${work.reportType} – ERROR: ${message}`);
    return { success: 0, error: 1, skipped: 0 };
  }
}

// --- Report data fetcher dispatch ---

async function fetchZoneReportData(
  token: string,
  zoneId: string,
  since: string,
  until: string,
  reportType: ZoneReportType,
  accountId?: string,
): Promise<unknown> {
  switch (reportType) {
    case "executive": {
      const m = getReportData();
      return m.fetchExecutiveDataServer(token, zoneId, since, until);
    }
    case "security": {
      const m = getReportData();
      return m.fetchSecurityDataServer(token, zoneId, since, until);
    }
    case "traffic": {
      const m = getReportData();
      return m.fetchTrafficDataServer(token, zoneId, since, until);
    }
    case "performance": {
      const m = getReportData();
      return m.fetchPerformanceDataServer(token, zoneId, since, until);
    }
    case "dns": {
      const m = getReportData();
      return m.fetchDnsDataServer(token, zoneId, since, until);
    }
    case "origin-health": {
      const m = getReportDataZone();
      return m.fetchOriginHealthDataServer(token, zoneId, since, until);
    }
    case "ssl": {
      const m = getReportDataZone();
      return m.fetchSslDataServer(token, zoneId, since, until);
    }
    case "bots": {
      const m = getReportDataZone();
      return m.fetchBotDataServer(token, zoneId, since, until);
    }
    case "api-shield": {
      const m = getReportDataZone();
      return m.fetchApiShieldDataServer(token, zoneId, since, until);
    }
    case "ddos": {
      const m = getReportDataZone();
      return m.fetchDdosDataServer(token, zoneId, since, until, accountId);
    }
  }
}

async function fetchAccountReportData(
  token: string,
  accountId: string,
  since: string,
  until: string,
  reportType: AccountReportType,
): Promise<unknown> {
  const m = getReportDataZt();
  switch (reportType) {
    case "gateway-dns":
      return m.fetchGatewayDnsDataServer(token, accountId, since, until);
    case "gateway-network":
      return m.fetchGatewayNetworkDataServer(token, accountId, since, until);
    case "shadow-it":
      return m.fetchShadowItDataServer(token, accountId, since, until);
    case "devices-users":
      return m.fetchDevicesUsersDataServer(token, accountId);
    case "zt-summary":
      return m.fetchZtSummaryDataServer(token, accountId, since, until);
    case "access-audit":
      return m.fetchAccessAuditDataServer(token, accountId, since, until);
  }
}

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
