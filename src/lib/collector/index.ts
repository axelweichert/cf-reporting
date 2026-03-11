/**
 * Scheduled data collector – fetches all 5 report types for every zone
 * and stores snapshots in SQLite for persistence across restarts.
 *
 * Requires CF_API_TOKEN + writable SQLite database.
 */

import cron, { type ScheduledTask } from "node-cron";
import { CloudflareClient } from "@/lib/cf-client";
import { discoverZones } from "@/lib/token";
import {
  fetchExecutiveDataServer,
  fetchSecurityDataServer,
  fetchTrafficDataServer,
  fetchPerformanceDataServer,
  fetchDnsDataServer,
} from "@/lib/email/report-data";

type ReportType = "executive" | "security" | "traffic" | "performance" | "dns";
const REPORT_TYPES: ReportType[] = ["executive", "security", "traffic", "performance", "dns"];

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
    const zones = await discoverZones(client);

    if (zones.length === 0) {
      console.warn("[collector] No zones discovered – check token permissions");
      _lastRunStatus = "error";
      _lastRunAt = new Date().toISOString();
      return;
    }

    console.log(`[collector] Discovered ${zones.length} zone(s)`);

    // 7-day collection period
    const until = new Date();
    const since = new Date(until);
    since.setDate(since.getDate() - 7);
    const sinceStr = since.toISOString();
    const untilStr = until.toISOString();

    for (const zone of zones) {
      for (const reportType of REPORT_TYPES) {
        const fetchStart = Date.now();
        try {
          const data = await fetchReportData(token, zone.id, sinceStr, untilStr, reportType);
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

async function fetchReportData(
  token: string,
  zoneId: string,
  since: string,
  until: string,
  reportType: ReportType,
): Promise<unknown> {
  switch (reportType) {
    case "executive":
      return fetchExecutiveDataServer(token, zoneId, since, until);
    case "security":
      return fetchSecurityDataServer(token, zoneId, since, until);
    case "traffic":
      return fetchTrafficDataServer(token, zoneId, since, until);
    case "performance":
      return fetchPerformanceDataServer(token, zoneId, since, until);
    case "dns":
      return fetchDnsDataServer(token, zoneId, since, until);
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
  };
}

export function stopCollector(): void {
  if (_cronTask) {
    _cronTask.stop();
    _cronTask = null;
  }
}
