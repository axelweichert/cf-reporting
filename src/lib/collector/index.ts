/**
 * Scheduled data collector – fetches all 16 report types for every zone
 * and account, then stores snapshots in SQLite for persistence across restarts.
 *
 * Zone-scoped (10): executive, security, traffic, performance, dns,
 *                   origin-health, ssl, bots, api-shield, ddos
 * Account-scoped (6): gateway-dns, gateway-network, shadow-it,
 *                     devices-users, zt-summary, access-audit
 *
 * Requires CF_API_TOKEN + writable SQLite database.
 */

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

/** Lazy-load snapshot helpers. */
function getSnapshots() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/lib/snapshots") as typeof import("@/lib/snapshots");
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

  const snap = getSnapshots();

  _running = true;
  const runId = snap.generateRunId();
  const startTime = Date.now();
  let errorCount = 0;
  let successCount = 0;

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

    // 7-day collection period
    const until = new Date();
    const since = new Date(until);
    since.setDate(since.getDate() - 7);
    const sinceStr = since.toISOString();
    const untilStr = until.toISOString();

    // Zone-scoped collection (10 report types)
    for (const zone of zones) {
      for (const reportType of ZONE_REPORT_TYPES) {
        const fetchStart = Date.now();
        try {
          const data = await fetchZoneReportData(
            token, zone.id, sinceStr, untilStr, reportType,
            accounts[0]?.id, // for DDoS L3/L4 data
          );
          snap.upsertSnapshot(zone.id, zone.name, reportType, sinceStr, untilStr, data);
          const duration = Date.now() - fetchStart;
          snap.logCollection(runId, zone.id, zone.name, reportType, "success", duration);
          successCount++;
          console.log(`[collector] ${zone.name} / ${reportType} – OK (${duration}ms)`);
        } catch (err) {
          const duration = Date.now() - fetchStart;
          const message = err instanceof Error ? err.message : "Unknown error";
          snap.logCollection(runId, zone.id, zone.name, reportType, "error", duration, message);
          errorCount++;
          console.error(`[collector] ${zone.name} / ${reportType} – ERROR: ${message}`);
        }
      }
    }

    // Account-scoped collection (6 Zero Trust report types)
    for (const account of accounts) {
      for (const reportType of ACCOUNT_REPORT_TYPES) {
        const fetchStart = Date.now();
        try {
          const data = await fetchAccountReportData(
            token, account.id, sinceStr, untilStr, reportType,
          );
          snap.upsertSnapshot(account.id, account.name, reportType, sinceStr, untilStr, data);
          const duration = Date.now() - fetchStart;
          snap.logCollection(runId, account.id, account.name, reportType, "success", duration);
          successCount++;
          console.log(`[collector] ${account.name} / ${reportType} – OK (${duration}ms)`);
        } catch (err) {
          const duration = Date.now() - fetchStart;
          const message = err instanceof Error ? err.message : "Unknown error";
          snap.logCollection(runId, account.id, account.name, reportType, "error", duration, message);
          errorCount++;
          console.error(`[collector] ${account.name} / ${reportType} – ERROR: ${message}`);
        }
      }
    }

    // Retention cleanup
    const retentionDays = parseInt(process.env.DATA_RETENTION_DAYS || "90", 10);
    const cleaned = snap.cleanupOldData(retentionDays);
    if (cleaned.deletedSnapshots > 0 || cleaned.deletedLogs > 0) {
      console.log(`[collector] Cleanup: removed ${cleaned.deletedSnapshots} snapshots, ${cleaned.deletedLogs} log entries`);
    }

    _lastRunStatus = errorCount === 0 ? "success" : "partial";
  } catch (err) {
    console.error("[collector] Collection run failed:", err instanceof Error ? err.message : err);
    _lastRunStatus = "error";
  } finally {
    _running = false;
    _lastRunAt = new Date().toISOString();
    const totalDuration = Date.now() - startTime;
    console.log(`[collector] Run ${runId} complete: ${successCount} success, ${errorCount} errors (${totalDuration}ms)`);
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
  return {
    enabled: !!process.env.CF_API_TOKEN && checkDb(),
    running: _running,
    lastRunAt: _lastRunAt,
    lastRunStatus: _lastRunStatus,
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
