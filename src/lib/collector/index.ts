/**
 * Scheduled data collector – fetches all 16 report types for every zone
 * and account, then stores data in normalized SQLite tables.
 *
 * Zone-scoped (10): executive, security, traffic, performance, dns,
 *                   origin-health, ssl, bots, api-shield, ddos
 * Account-scoped (6): gateway-dns, gateway-network, shadow-it,
 *                     devices-users, zt-summary, access-audit
 *
 * Requires CF_API_TOKEN + writable SQLite database.
 */

import { randomUUID } from "crypto";
import cron, { type ScheduledTask } from "node-cron";
import { CloudflareClient } from "@/lib/cf-client";
import { discoverZones, discoverAccounts } from "@/lib/token";

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
    // Default first-run period: 24h (safe for free-plan zones with 86400s limit)
    const defaultSince = new Date(now);
    defaultSince.setDate(defaultSince.getDate() - 1);
    const defaultSinceStr = defaultSince.toISOString();
    // Overlap buffer: 1 hour back from last period_end to avoid gaps
    // if the scheduler was delayed or a run took longer than expected
    const OVERLAP_MS = 60 * 60 * 1000;

    // Zone-scoped collection (10 report types)
    for (const zone of zones) {
      for (const reportType of ZONE_REPORT_TYPES) {
        const fetchStart = Date.now();
        try {
          const lastTs = store.getLastTimestamp(zone.id, reportType);
          const lastEnd = lastTs ? new Date(lastTs * 1000).toISOString() : null;
          let fetchSince: string;
          let label: string;
          if (lastEnd) {
            // Fetch with 1h overlap for safety
            const overlapped = new Date(new Date(lastEnd).getTime() - OVERLAP_MS);
            fetchSince = overlapped.toISOString();
            label = "incremental";
          } else {
            fetchSince = defaultSinceStr;
            label = "initial 24h";
          }

          const data = await fetchZoneReportData(
            token, zone.id, fetchSince, nowStr, reportType,
            accounts[0]?.id, // for DDoS L3/L4 data
          );

          const collectedAt = Math.floor(Date.now() / 1000);
          store.storeReportData(zone.id, zone.name, reportType, collectedAt, data);
          const duration = Date.now() - fetchStart;
          store.logCollectionItem(runId, zone.id, zone.name, reportType, "success", duration);
          successCount++;
          console.log(`[collector] ${zone.name} / ${reportType} – OK (${duration}ms) [${label}]`);
        } catch (err) {
          const duration = Date.now() - fetchStart;
          const message = err instanceof Error ? err.message : "Unknown error";
          if (isPermissionError(message)) {
            store.logCollectionItem(runId, zone.id, zone.name, reportType, "skipped", duration, message);
            skippedCount++;
            console.log(`[collector] ${zone.name} / ${reportType} – SKIPPED (${duration}ms) [permission]`);
          } else {
            store.logCollectionItem(runId, zone.id, zone.name, reportType, "error", duration, message);
            errorCount++;
            console.error(`[collector] ${zone.name} / ${reportType} – ERROR: ${message}`);
          }
        }
      }
    }

    // Account-scoped collection (6 Zero Trust report types)
    for (const account of accounts) {
      for (const reportType of ACCOUNT_REPORT_TYPES) {
        const fetchStart = Date.now();
        try {
          const lastTs = store.getLastTimestamp(account.id, reportType);
          const lastEnd = lastTs ? new Date(lastTs * 1000).toISOString() : null;
          let fetchSince: string;
          let label: string;
          if (lastEnd) {
            const overlapped = new Date(new Date(lastEnd).getTime() - OVERLAP_MS);
            fetchSince = overlapped.toISOString();
            label = "incremental";
          } else {
            fetchSince = defaultSinceStr;
            label = "initial 24h";
          }

          const data = await fetchAccountReportData(
            token, account.id, fetchSince, nowStr, reportType,
          );

          const collectedAt = Math.floor(Date.now() / 1000);
          store.storeReportData(account.id, account.name, reportType, collectedAt, data);
          const duration = Date.now() - fetchStart;
          store.logCollectionItem(runId, account.id, account.name, reportType, "success", duration);
          successCount++;
          console.log(`[collector] ${account.name} / ${reportType} – OK (${duration}ms) [${label}]`);
        } catch (err) {
          const duration = Date.now() - fetchStart;
          const message = err instanceof Error ? err.message : "Unknown error";
          if (isPermissionError(message)) {
            store.logCollectionItem(runId, account.id, account.name, reportType, "skipped", duration, message);
            skippedCount++;
            console.log(`[collector] ${account.name} / ${reportType} – SKIPPED (${duration}ms) [permission]`);
          } else {
            store.logCollectionItem(runId, account.id, account.name, reportType, "error", duration, message);
            errorCount++;
            console.error(`[collector] ${account.name} / ${reportType} – ERROR: ${message}`);
          }
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
