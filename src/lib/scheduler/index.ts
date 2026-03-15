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
import { fetchExecutiveDataServer, fetchSecurityDataServer, fetchTrafficDataServer, fetchPerformanceDataServer, fetchDnsDataServer } from "@/lib/email/report-data";
import { fetchSslDataServer, fetchBotDataServer, fetchDdosDataServer, fetchOriginHealthDataServer, fetchApiShieldDataServer } from "@/lib/email/report-data-zone";
import { fetchZtSummaryDataServer, fetchGatewayDnsDataServer, fetchGatewayNetworkDataServer, fetchAccessAuditDataServer, fetchShadowItDataServer, fetchDevicesUsersDataServer } from "@/lib/email/report-data-zt";
import { renderExecutiveEmail } from "@/lib/email/templates/executive";
import { renderSecurityEmail } from "@/lib/email/templates/security";
import { renderTrafficEmail } from "@/lib/email/templates/traffic";
import { renderPerformanceEmail } from "@/lib/email/templates/performance";
import { renderDnsEmail } from "@/lib/email/templates/dns";
import { renderSslEmail } from "@/lib/email/templates/ssl";
import { renderDdosEmail } from "@/lib/email/templates/ddos";
import { renderBotsEmail } from "@/lib/email/templates/bots";
import { renderOriginHealthEmail } from "@/lib/email/templates/origin-health";
import { renderApiShieldEmail } from "@/lib/email/templates/api-shield";
import { renderZtSummaryEmail } from "@/lib/email/templates/zt-summary";
import { renderGatewayDnsEmail } from "@/lib/email/templates/gateway-dns";
import { renderGatewayNetworkEmail } from "@/lib/email/templates/gateway-network";
import { renderAccessAuditEmail } from "@/lib/email/templates/access-audit";
import { renderShadowItEmail } from "@/lib/email/templates/shadow-it";
import { renderDevicesUsersEmail } from "@/lib/email/templates/devices-users";
import { getDateRange } from "@/lib/store-server";
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
    const since = `${start}T00:00:00Z`;
    const until = `${end}T00:00:00Z`;

    // Determine which report types to run
    const reportTypes = schedule.reportTypes && schedule.reportTypes.length > 0
      ? schedule.reportTypes
      : [schedule.reportType];

    for (const reportType of reportTypes) {
      const isAccountScoped = ACCOUNT_SCOPED_REPORTS.includes(reportType);
      const scopeName = isAccountScoped ? (schedule.accountName || schedule.zoneName) : schedule.zoneName;
      const scopeId = isAccountScoped ? (schedule.accountId || schedule.zoneId) : schedule.zoneId;

      const { html, subject: defaultSubject } = await renderReport(
        token, reportType, scopeId, scopeName, since, until, start, end,
        isAccountScoped ? schedule.accountId : undefined,
      );

      const subject = schedule.subject || defaultSubject;
      const format = schedule.format || "html";

      const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];

      if (format === "html" || format === "both") {
        attachments.push({
          filename: `${reportType}-report.html`,
          content: Buffer.from(html, "utf-8"),
          contentType: "text/html",
        });
      }
      if (format === "pdf" || format === "both") {
        const pdfBuffer = await renderScheduledPdf(reportType, scopeId, scopeName, schedule.timeRange, isAccountScoped);
        attachments.push({
          filename: `${reportType}-report.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        });
      }

      await sendReportEmailWithAttachments(
        schedule.recipients, subject,
        `Your ${REPORT_LABELS[reportType]} for ${scopeName} (${start} to ${end}) is attached.`,
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

async function renderScheduledPdf(
  reportType: ReportType,
  scopeId: string,
  scopeName: string,
  timeRange: string,
  isAccountScoped: boolean,
): Promise<Buffer> {
  const { generatePdf } = await import("@/lib/pdf/browser-pool");
  const { sealData } = await import("iron-session");
  const { sessionOptions } = await import("@/lib/session");

  // Create a server-side session cookie so Playwright can authenticate
  const token = getEnvToken()!;
  const sessionCookie = await sealData(
    { token, tokenType: "api", tokenSource: "env", siteAuthenticated: true },
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

  const title = REPORT_LABELS[reportType];
  return generatePdf({
    url: url.toString(),
    sessionCookie,
    title,
    ...(isAccountScoped ? { accountName: scopeName } : { zoneName: scopeName }),
  });
}

async function renderReport(
  token: string,
  reportType: ReportType,
  scopeId: string,
  scopeName: string,
  since: string,
  until: string,
  startDate: string,
  endDate: string,
  accountId?: string,
): Promise<{ html: string; subject: string }> {
  const label = REPORT_LABELS[reportType];
  const zoneMeta = { zoneName: scopeName, startDate, endDate };
  const accountMeta = { accountName: scopeName, startDate, endDate };
  const subjectPrefix = `[cf-reporting] ${label} – ${scopeName} – ${startDate} to ${endDate}`;

  switch (reportType) {
    case "executive": {
      const data = await fetchExecutiveDataServer(token, scopeId, since, until);
      return { html: renderExecutiveEmail(data, zoneMeta), subject: subjectPrefix };
    }
    case "security": {
      const data = await fetchSecurityDataServer(token, scopeId, since, until);
      return { html: renderSecurityEmail(data, zoneMeta), subject: subjectPrefix };
    }
    case "traffic": {
      const data = await fetchTrafficDataServer(token, scopeId, since, until);
      return { html: renderTrafficEmail(data, zoneMeta), subject: subjectPrefix };
    }
    case "performance": {
      const data = await fetchPerformanceDataServer(token, scopeId, since, until);
      return { html: renderPerformanceEmail(data, zoneMeta), subject: subjectPrefix };
    }
    case "dns": {
      const data = await fetchDnsDataServer(token, scopeId, since, until);
      return { html: renderDnsEmail(data, zoneMeta), subject: subjectPrefix };
    }
    case "ssl": {
      const data = await fetchSslDataServer(token, scopeId, since, until);
      return { html: renderSslEmail(data, zoneMeta), subject: subjectPrefix };
    }
    case "ddos": {
      const data = await fetchDdosDataServer(token, scopeId, since, until, accountId);
      return { html: renderDdosEmail(data, zoneMeta), subject: subjectPrefix };
    }
    case "bots": {
      const data = await fetchBotDataServer(token, scopeId, since, until);
      return { html: renderBotsEmail(data, zoneMeta), subject: subjectPrefix };
    }
    case "origin-health": {
      const data = await fetchOriginHealthDataServer(token, scopeId, since, until);
      return { html: renderOriginHealthEmail(data, zoneMeta), subject: subjectPrefix };
    }
    case "api-shield": {
      const data = await fetchApiShieldDataServer(token, scopeId, since, until);
      return { html: renderApiShieldEmail(data, zoneMeta), subject: subjectPrefix };
    }
    case "zt-summary": {
      const data = await fetchZtSummaryDataServer(token, scopeId, since, until);
      return { html: renderZtSummaryEmail(data, accountMeta), subject: subjectPrefix };
    }
    case "gateway-dns": {
      const data = await fetchGatewayDnsDataServer(token, scopeId, since, until);
      return { html: renderGatewayDnsEmail(data, accountMeta), subject: subjectPrefix };
    }
    case "gateway-network": {
      const data = await fetchGatewayNetworkDataServer(token, scopeId, since, until);
      return { html: renderGatewayNetworkEmail(data, accountMeta), subject: subjectPrefix };
    }
    case "access-audit": {
      const data = await fetchAccessAuditDataServer(token, scopeId, since, until);
      return { html: renderAccessAuditEmail(data, accountMeta), subject: subjectPrefix };
    }
    case "shadow-it": {
      const data = await fetchShadowItDataServer(token, scopeId, since, until);
      return { html: renderShadowItEmail(data, accountMeta), subject: subjectPrefix };
    }
    case "devices-users": {
      const data = await fetchDevicesUsersDataServer(token, scopeId);
      return { html: renderDevicesUsersEmail(data, accountMeta), subject: subjectPrefix };
    }
    default: {
      const _exhaustive: never = reportType;
      throw new Error(`Unsupported report type: ${_exhaustive}`);
    }
  }
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
