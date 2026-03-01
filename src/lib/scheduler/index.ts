/**
 * Email report scheduler.
 *
 * Uses node-cron to run scheduled report deliveries.
 * Initialized via instrumentation.ts on server startup.
 * Only runs when SMTP env vars AND CF_API_TOKEN are configured.
 *
 * Schedules are stored in-memory (configured via env or API).
 * They do NOT survive restarts – this is by design (stateless app).
 */

import cron, { type ScheduledTask } from "node-cron";
import { isSmtpConfiguredViaEnv, sendReportEmail } from "@/lib/email/smtp-client";
import { fetchExecutiveDataServer, fetchSecurityDataServer } from "@/lib/email/report-data";
import { renderExecutiveEmail } from "@/lib/email/templates/executive";
import { renderSecurityEmail } from "@/lib/email/templates/security";
import { getDateRange } from "@/lib/store-server";
import type { ScheduleConfig } from "@/types/email";

const activeTasks = new Map<string, ScheduledTask>();
const schedules: ScheduleConfig[] = [];
let _running = false;

export function isSchedulerRunning(): boolean {
  return _running;
}

export function getSchedules(): ScheduleConfig[] {
  return [...schedules];
}

export function addSchedule(config: Omit<ScheduleConfig, "id" | "createdAt">): ScheduleConfig {
  const { randomUUID } = require("crypto");
  const schedule: ScheduleConfig = {
    ...config,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  schedules.push(schedule);
  reloadCronTasks();
  return schedule;
}

export function deleteSchedule(id: string): boolean {
  const idx = schedules.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  schedules.splice(idx, 1);
  reloadCronTasks();
  return true;
}

export function updateSchedule(id: string, update: Partial<Pick<ScheduleConfig, "enabled">>): ScheduleConfig | null {
  const schedule = schedules.find((s) => s.id === id);
  if (!schedule) return null;
  if (update.enabled !== undefined) schedule.enabled = update.enabled;
  reloadCronTasks();
  return { ...schedule };
}

export function initScheduler(): void {
  if (_running) return;

  const token = process.env.CF_API_TOKEN;
  if (!token) {
    console.log("[scheduler] CF_API_TOKEN not set – scheduled email delivery disabled");
    return;
  }

  if (!isSmtpConfiguredViaEnv()) {
    console.log("[scheduler] SMTP env vars not configured – scheduled email delivery disabled");
    // Don't return – SMTP might be configured later. We'll check on each run.
  }

  _running = true;
  console.log("[scheduler] Starting email report scheduler");
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
  const token = process.env.CF_API_TOKEN;
  if (!token) {
    updateRunStatus(scheduleId, "error", "CF_API_TOKEN not available");
    return;
  }

  if (!isSmtpConfiguredViaEnv()) {
    updateRunStatus(scheduleId, "error", "SMTP env vars not configured");
    return;
  }

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
    updateRunStatus(scheduleId, "success");
    console.log(`[scheduler] Successfully sent ${schedule.reportType} report to ${schedule.recipients.length} recipient(s)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    updateRunStatus(scheduleId, "error", message);
    console.error(`[scheduler] Failed to send schedule ${scheduleId}:`, message);
  }
}

function updateRunStatus(id: string, status: "success" | "error", error?: string): void {
  const schedule = schedules.find((s) => s.id === id);
  if (!schedule) return;
  schedule.lastRunAt = new Date().toISOString();
  schedule.lastRunStatus = status;
  schedule.lastRunError = error;
}
