/**
 * Email report scheduler.
 *
 * Uses node-cron to run scheduled report deliveries.
 * Initialized via instrumentation.ts on server startup.
 * Only runs when SMTP is configured and CF_API_TOKEN is available.
 */

import cron, { type ScheduledTask } from "node-cron";
import { getSchedules, updateScheduleRunStatus } from "@/lib/config/config-store";
import { isSmtpConfigured, sendReportEmail } from "@/lib/email/smtp-client";
import { fetchExecutiveDataServer, fetchSecurityDataServer } from "@/lib/email/report-data";
import { renderExecutiveEmail } from "@/lib/email/templates/executive";
import { renderSecurityEmail } from "@/lib/email/templates/security";
import { getDateRange } from "@/lib/store-server";

const activeTasks = new Map<string, ScheduledTask>();
let _running = false;

export function isSchedulerRunning(): boolean {
  return _running;
}

export function initScheduler(): void {
  if (_running) return;

  const token = process.env.CF_API_TOKEN;
  if (!token) {
    console.log("[scheduler] CF_API_TOKEN not set — scheduled email delivery disabled");
    return;
  }

  if (!isSmtpConfigured()) {
    console.log("[scheduler] SMTP not configured — scheduled email delivery disabled");
    // Don't return — SMTP might be configured later via UI. We'll check on each run.
  }

  _running = true;
  console.log("[scheduler] Starting email report scheduler");
  loadSchedules();
}

export function reloadSchedules(): void {
  // Stop all existing tasks
  for (const [id, task] of activeTasks) {
    task.stop();
    activeTasks.delete(id);
  }

  if (!_running) return;
  loadSchedules();
}

function loadSchedules(): void {
  const schedules = getSchedules();
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
    updateScheduleRunStatus(scheduleId, "error", "CF_API_TOKEN not available");
    return;
  }

  if (!isSmtpConfigured()) {
    updateScheduleRunStatus(scheduleId, "error", "SMTP not configured");
    return;
  }

  // Re-read schedule in case it was updated
  const schedules = getSchedules();
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
        if (!subject) subject = `[cf-reporting] Executive Report — ${meta.zoneName} — ${start} to ${end}`;
        break;
      }
      case "security": {
        const data = await fetchSecurityDataServer(token, schedule.zoneId, since, until);
        html = renderSecurityEmail(data, meta);
        if (!subject) subject = `[cf-reporting] Security Report — ${meta.zoneName} — ${start} to ${end}`;
        break;
      }
      default:
        throw new Error(`Unsupported report type: ${schedule.reportType}`);
    }

    await sendReportEmail(schedule.recipients, subject, html);
    updateScheduleRunStatus(scheduleId, "success");
    console.log(`[scheduler] Successfully sent ${schedule.reportType} report to ${schedule.recipients.length} recipient(s)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    updateScheduleRunStatus(scheduleId, "error", message);
    console.error(`[scheduler] Failed to send schedule ${scheduleId}:`, message);
  }
}
