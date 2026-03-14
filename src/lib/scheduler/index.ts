/**
 * Email report scheduler.
 *
 * Uses node-cron to run scheduled report deliveries.
 * Initialized via instrumentation.ts on server startup.
 * Only runs when SMTP env vars AND a Cloudflare env token (CF_API_TOKEN or CF_ACCOUNT_TOKEN) are configured.
 *
 * Schedules are persisted in SQLite and survive container restarts.
 */

import cron, { type ScheduledTask } from "node-cron";
import { isSmtpConfiguredViaEnv, sendReportEmail } from "@/lib/email/smtp-client";
import { fetchExecutiveDataServer, fetchSecurityDataServer } from "@/lib/email/report-data";
import { renderExecutiveEmail } from "@/lib/email/templates/executive";
import { renderSecurityEmail } from "@/lib/email/templates/security";
import { getDateRange } from "@/lib/store-server";
import {
  getSchedulesFromDb,
  saveScheduleToDb,
  deleteScheduleFromDb,
  updateScheduleEnabledInDb,
  updateScheduleRunStatusInDb,
} from "@/lib/data-store";
import type { ScheduleConfig } from "@/types/email";

const activeTasks = new Map<string, ScheduledTask>();
let _running = false;

export function isSchedulerRunning(): boolean {
  return _running;
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

export function updateSchedule(id: string, update: Partial<Pick<ScheduleConfig, "enabled">>): ScheduleConfig | null {
  if (update.enabled !== undefined) {
    const updated = updateScheduleEnabledInDb(id, update.enabled);
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
  if (_running) return;

  const token = getEnvToken();
  if (!token) {
    console.log("[scheduler] No CF_API_TOKEN or CF_ACCOUNT_TOKEN – scheduled email delivery disabled");
    return;
  }

  if (!isSmtpConfiguredViaEnv()) {
    console.log("[scheduler] SMTP env vars not configured – scheduled email delivery disabled");
    // Don't return – SMTP might be configured later. We'll check on each run.
  }

  _running = true;
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

  if (!_running) return;

  const schedules = getSchedulesFromDb();
  let loaded = 0;
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    if (!cron.validate(schedule.cronExpression)) {
      console.warn(`[scheduler] Invalid cron expression for schedule ${schedule.id}: ${schedule.cronExpression}`);
      continue;
    }

    const task = cron.schedule(schedule.cronExpression, () => {
      runSchedule(schedule.id).catch((err) => {
        console.error(`[scheduler] Error running schedule ${schedule.id}:`, err.message);
      });
    }, { timezone: "UTC" });

    activeTasks.set(schedule.id, task);
    loaded++;
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

    const meta = {
      zoneName: schedule.zoneName,
      startDate: start,
      endDate: end,
    };

    let html: string;
    let subject = schedule.subject || "";

    switch (schedule.reportType) {
      case "executive": {
        const data = await fetchExecutiveDataServer(token, schedule.zoneId, since, until);
        html = renderExecutiveEmail(data, meta);
        if (!subject) subject = `[cf-reporting] Executive Report – ${meta.zoneName} – ${start} to ${end}`;
        break;
      }
      case "security": {
        const data = await fetchSecurityDataServer(token, schedule.zoneId, since, until);
        html = renderSecurityEmail(data, meta);
        if (!subject) subject = `[cf-reporting] Security Report – ${meta.zoneName} – ${start} to ${end}`;
        break;
      }
      default:
        throw new Error(`Unsupported report type: ${schedule.reportType}`);
    }

    // No session SMTP – scheduler always uses env SMTP
    await sendReportEmail(schedule.recipients, subject, html);
    updateScheduleRunStatusInDb(scheduleId, "success");
    console.log(`[scheduler] Successfully sent ${schedule.reportType} report to ${schedule.recipients.length} recipient(s)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    updateScheduleRunStatusInDb(scheduleId, "error", message);
    console.error(`[scheduler] Failed to send schedule ${scheduleId}:`, message);
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
