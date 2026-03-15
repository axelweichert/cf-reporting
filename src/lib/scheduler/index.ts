/**
 * Email report scheduler.
 *
 * Uses Croner to run scheduled report deliveries.
 * Initialized via instrumentation.ts on server startup.
 * Only runs when SMTP env vars AND a Cloudflare env token (CF_API_TOKEN or CF_ACCOUNT_TOKEN) are configured.
 *
 * Schedules are persisted in SQLite and survive container restarts.
 */

import { Cron } from "croner";
import { isSmtpConfiguredViaEnv, sendReportEmailWithAttachments } from "@/lib/email/smtp-client";
import { getDateRange } from "@/lib/store-server";
import { buildReportFilename } from "@/lib/report-pages";
import {
  getSchedulesFromDb,
  saveScheduleToDb,
  deleteScheduleFromDb,
  updateScheduleEnabledInDb,
  updateScheduleFieldsInDb,
  updateScheduleRunStatusInDb,
} from "@/lib/data-store";
import type { ScheduleConfig, ReportType } from "@/types/email";
import { ACCOUNT_SCOPED_REPORTS } from "@/types/email";

// Store scheduler state on globalThis so it survives Next.js module re-evaluation.
// Without this, API route handlers get a different module instance than
// instrumentation.ts, so reloadCronTasks() sees _running=false and exits.
interface SchedulerGlobal {
  __cfr_scheduler_running?: boolean;
  __cfr_scheduler_tasks?: Map<string, Cron>;
}
const _g = globalThis as SchedulerGlobal;
if (!_g.__cfr_scheduler_tasks) _g.__cfr_scheduler_tasks = new Map();
const activeTasks = _g.__cfr_scheduler_tasks;

const REPORT_LABELS: Record<ReportType, string> = {
  executive: "Executive Report",
  security: "Security Report",
  traffic: "Traffic Report",
  dns: "DNS Report",
  performance: "Performance Report",
  ssl: "SSL/TLS Report",
  ddos: "DDoS Report",
  bots: "Bot Analysis Report",
  "origin-health": "Origin Health Report",
  "api-shield": "API Shield Report",
  "zt-summary": "Zero Trust Summary",
  "gateway-dns": "Gateway DNS & HTTP Report",
  "gateway-network": "Gateway Network Report",
  "access-audit": "Access Audit Report",
  "shadow-it": "Shadow IT Report",
  "devices-users": "Devices & Users Report",
};

export function isSchedulerRunning(): boolean {
  return !!_g.__cfr_scheduler_running;
}

export function getSchedules(): ScheduleConfig[] {
  return getSchedulesFromDb();
}

export function addSchedule(config: Omit<ScheduleConfig, "id" | "createdAt">): ScheduleConfig {
  const { randomUUID } = require("crypto");
  const schedule: ScheduleConfig = {
    ...config,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  saveScheduleToDb(schedule);
  reloadCronTasks();
  return schedule;
}

export function deleteSchedule(id: string): boolean {
  const removed = deleteScheduleFromDb(id);
  if (removed) reloadCronTasks();
  return removed;
}

export function updateSchedule(id: string, update: Partial<ScheduleConfig>): ScheduleConfig | null {
  // Simple toggle-only path
  if (Object.keys(update).length === 1 && update.enabled !== undefined) {
    const updated = updateScheduleEnabledInDb(id, update.enabled);
    if (!updated) return null;
  } else {
    const updated = updateScheduleFieldsInDb(id, update);
    if (!updated) return null;
  }
  reloadCronTasks();
  const schedules = getSchedulesFromDb();
  return schedules.find((s) => s.id === id) ?? null;
}

function getEnvToken(): string | undefined {
  return process.env.CF_API_TOKEN || process.env.CF_ACCOUNT_TOKEN;
}

export function initScheduler(): void {
  if (_g.__cfr_scheduler_running) return;

  const token = getEnvToken();
  if (!token) {
    console.log("[scheduler] No CF_API_TOKEN or CF_ACCOUNT_TOKEN – scheduled email delivery disabled");
    return;
  }

  if (!isSmtpConfiguredViaEnv()) {
    console.log("[scheduler] SMTP env vars not configured – scheduled email delivery disabled");
    // Don't return – SMTP might be configured later. We'll check on each run.
  }

  _g.__cfr_scheduler_running = true;
  console.log("[scheduler] Starting email report scheduler");
  reloadCronTasks();
}

export function reloadSchedules(): void {
  reloadCronTasks();
}

function reloadCronTasks(): void {
  // Stop all existing cron tasks
  for (const [id, task] of activeTasks) {
    task.stop();
    activeTasks.delete(id);
  }

  if (!_g.__cfr_scheduler_running) return;

  const schedules = getSchedulesFromDb();
  let loaded = 0;
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;

    try {
      const task = new Cron(schedule.cronExpression, {
        timezone: schedule.timezone || "UTC",
      }, () => {
        runSchedule(schedule.id).catch((err) => {
          console.error(`[scheduler] Error running schedule ${schedule.id}:`, err.message);
        });
      });

      activeTasks.set(schedule.id, task);
      loaded++;
    } catch (err) {
      console.warn(`[scheduler] Invalid cron expression for schedule ${schedule.id}: ${schedule.cronExpression} – ${(err as Error).message}`);
    }
  }

  if (loaded > 0) {
    console.log(`[scheduler] Loaded ${loaded} schedule(s)`);
  }
}

async function runSchedule(scheduleId: string): Promise<void> {
  const token = getEnvToken();
  if (!token) {
    updateScheduleRunStatusInDb(scheduleId, "error", "No CF_API_TOKEN or CF_ACCOUNT_TOKEN available");
    return;
  }

  if (!isSmtpConfiguredViaEnv()) {
    updateScheduleRunStatusInDb(scheduleId, "error", "SMTP env vars not configured");
    return;
  }

  const schedules = getSchedulesFromDb();
  const schedule = schedules.find((s) => s.id === scheduleId);
  if (!schedule || !schedule.enabled) return;

  try {
    const { start, end } = getDateRange(schedule.timeRange);

    // Determine which report types to run
    const reportTypes = schedule.reportTypes && schedule.reportTypes.length > 0
      ? schedule.reportTypes
      : [schedule.reportType];

    for (const reportType of reportTypes) {
      const isAccountScoped = ACCOUNT_SCOPED_REPORTS.includes(reportType);
      const scopeName = isAccountScoped ? (schedule.accountName || schedule.zoneName) : schedule.zoneName;
      const scopeId = isAccountScoped ? (schedule.accountId || schedule.zoneId) : schedule.zoneId;

      const label = REPORT_LABELS[reportType];
      const subject = schedule.subject || `[cf-reporting] ${label} \u2013 ${scopeName} \u2013 ${start} to ${end}`;
      const format = schedule.format || "html";
      const nameOpts = isAccountScoped ? { accountName: scopeName } : { zoneName: scopeName };
      const renderOpts = await buildRenderOpts(reportType, scopeId, scopeName, schedule.timeRange, isAccountScoped);

      const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];

      if (format === "html" || format === "both") {
        const { generateHtml } = await import("@/lib/pdf/browser-pool");
        const htmlBuffer = await generateHtml(renderOpts);
        attachments.push({
          filename: buildReportFilename(label, "html", nameOpts),
          content: htmlBuffer,
          contentType: "text/html",
        });
      }
      if (format === "pdf" || format === "both") {
        const { generatePdf } = await import("@/lib/pdf/browser-pool");
        const pdfBuffer = await generatePdf(renderOpts);
        attachments.push({
          filename: buildReportFilename(label, "pdf", nameOpts),
          content: pdfBuffer,
          contentType: "application/pdf",
        });
      }

      await sendReportEmailWithAttachments(
        schedule.recipients, subject,
        `Your ${label} for ${scopeName} (${start} to ${end}) is attached.`,
        attachments,
      );

      console.log(`[scheduler] Successfully sent ${reportType} (${format}) report to ${schedule.recipients.length} recipient(s)`);
    }

    updateScheduleRunStatusInDb(scheduleId, "success");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    updateScheduleRunStatusInDb(scheduleId, "error", message);
    console.error(`[scheduler] Failed to send schedule ${scheduleId}:`, message);
  }
}

async function buildRenderOpts(
  reportType: ReportType,
  scopeId: string,
  scopeName: string,
  timeRange: string,
  isAccountScoped: boolean,
) {
  const { sealData } = await import("iron-session");
  const { sessionOptions } = await import("@/lib/session");

  const sessionCookie = await sealData(
    { token: getEnvToken(), tokenType: "api", tokenSource: "env", siteAuthenticated: true },
    { password: sessionOptions.password as string },
  );

  const port = process.env.PORT || "3000";
  const url = new URL(`/${reportType}`, `http://localhost:${port}`);
  url.searchParams.set("_pdf", "true");
  url.searchParams.set("timeRange", timeRange);
  if (isAccountScoped) {
    url.searchParams.set("account", scopeId);
  } else {
    url.searchParams.set("zone", scopeId);
  }

  return {
    url: url.toString(),
    sessionCookie,
    title: REPORT_LABELS[reportType],
    ...(isAccountScoped ? { accountName: scopeName } : { zoneName: scopeName }),
  };
}

/**
 * Initialize the data collector.
 * Re-exported here so instrumentation.ts can import it from a module
 * that Turbopack already bundles (the collector module uses better-sqlite3
 * which Turbopack drops during static analysis).
 */
export async function initCollector(): Promise<void> {
  try {
    const collector = await import("@/lib/collector/index");
    collector.initCollector();
  } catch (err) {
    console.warn("[scheduler] Could not load data collector:", (err as Error).message);
  }
}
