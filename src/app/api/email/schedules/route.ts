import { getAuthenticatedSession, validateOrigin } from "@/lib/auth-helpers";
import type { ScheduleFrequency, ReportType, ReportFormat } from "@/types/email";
import { ACCOUNT_SCOPED_REPORTS } from "@/types/email";
import { NextRequest } from "next/server";

function buildCronExpression(frequency: ScheduleFrequency, hour: number, minute: number, dayOfWeek?: number, dayOfMonth?: number): string {
  switch (frequency) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${dayOfWeek ?? 1}`;
    case "monthly":
      return `${minute} ${hour} ${dayOfMonth ?? 1} * *`;
    default:
      return `${minute} ${hour} * * *`;
  }
}

/** GET: List all schedules */
export async function GET() {
  const session = await getAuthenticatedSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { getSchedules } = await import("@/lib/scheduler");
    return Response.json({ schedules: getSchedules() });
  } catch {
    return Response.json({ schedules: [] });
  }
}

interface CreateScheduleBody {
  reportType: ReportType;
  reportTypes?: ReportType[];
  frequency: ScheduleFrequency;
  hour: number;
  minute?: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  timezone?: string;
  recipients: string[];
  zoneId: string;
  zoneName: string;
  accountId?: string;
  accountName?: string;
  timeRange: "1d" | "7d" | "30d";
  format?: ReportFormat;
  subject?: string;
}

/** POST: Create a new schedule */
export async function POST(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const session = await getAuthenticatedSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.CF_API_TOKEN && !process.env.CF_ACCOUNT_TOKEN) {
    return Response.json(
      { error: "CF_API_TOKEN or CF_ACCOUNT_TOKEN environment variable is required for scheduled email delivery" },
      { status: 400 }
    );
  }

  try {
    const body = await request.json() as CreateScheduleBody;

    if (!body.reportType || !body.frequency || body.hour == null || !body.recipients?.length) {
      return Response.json({ error: "Missing required fields" }, { status: 400 });
    }

    const isAccountScoped = ACCOUNT_SCOPED_REPORTS.includes(body.reportType);
    if (isAccountScoped && !body.accountId) {
      return Response.json({ error: "Account ID is required for account-scoped reports" }, { status: 400 });
    }
    if (!isAccountScoped && !body.zoneId) {
      return Response.json({ error: "Zone ID is required for zone-scoped reports" }, { status: 400 });
    }

    if (typeof body.hour !== "number" || body.hour < 0 || body.hour > 23) {
      return Response.json({ error: "Hour must be 0-23" }, { status: 400 });
    }
    const minute = body.minute ?? 0;
    if (typeof minute !== "number" || minute < 0 || minute > 59) {
      return Response.json({ error: "Minute must be 0-59" }, { status: 400 });
    }

    // Validate dayOfWeek and dayOfMonth
    if (body.frequency === "weekly" && body.dayOfWeek != null && (body.dayOfWeek < 0 || body.dayOfWeek > 6)) {
      return Response.json({ error: "Day of week must be 0-6 (Sunday-Saturday)" }, { status: 400 });
    }
    if (body.frequency === "monthly" && body.dayOfMonth != null && (body.dayOfMonth < 1 || body.dayOfMonth > 31)) {
      return Response.json({ error: "Day of month must be 1-31" }, { status: 400 });
    }

    if (body.recipients.length > 10) {
      return Response.json({ error: "Maximum 10 recipients per schedule" }, { status: 400 });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const email of body.recipients) {
      if (typeof email !== "string" || !emailRegex.test(email)) {
        return Response.json({ error: `Invalid email address: ${email}` }, { status: 400 });
      }
    }

    const { getSchedules, addSchedule } = await import("@/lib/scheduler");

    if (getSchedules().length >= 20) {
      return Response.json({ error: "Maximum 20 schedules allowed" }, { status: 400 });
    }

    const cronExpression = buildCronExpression(body.frequency, body.hour, minute, body.dayOfWeek, body.dayOfMonth);

    const schedule = addSchedule({
      enabled: true,
      reportType: body.reportType,
      reportTypes: body.reportTypes,
      frequency: body.frequency,
      cronExpression,
      hour: body.hour,
      minute,
      dayOfWeek: body.dayOfWeek,
      dayOfMonth: body.dayOfMonth,
      timezone: body.timezone || "UTC",
      recipients: body.recipients,
      zoneId: body.zoneId || "",
      zoneName: body.zoneName || body.zoneId || "",
      accountId: body.accountId,
      accountName: body.accountName,
      timeRange: body.timeRange || "7d",
      format: body.format || "html",
      subject: body.subject,
    });

    return Response.json({ success: true, schedule });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create schedule";
    return Response.json({ error: message }, { status: 500 });
  }
}

/** DELETE: Remove a schedule by ID (passed as query param) */
export async function DELETE(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const session = await getAuthenticatedSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return Response.json({ error: "Missing schedule ID" }, { status: 400 });

  try {
    const { deleteSchedule } = await import("@/lib/scheduler");
    const deleted = deleteSchedule(id);
    if (!deleted) return Response.json({ error: "Schedule not found" }, { status: 404 });
    return Response.json({ success: true });
  } catch {
    return Response.json({ error: "Scheduler not available" }, { status: 500 });
  }
}

/** PATCH: Update a schedule (toggle enabled or full edit) */
export async function PATCH(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const session = await getAuthenticatedSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json() as Partial<CreateScheduleBody> & { id: string; enabled?: boolean };
    if (!body.id) return Response.json({ error: "Missing schedule ID" }, { status: 400 });

    // Rebuild cron expression if any time fields changed
    const update: Record<string, unknown> = {};
    if (body.enabled !== undefined) update.enabled = body.enabled;
    if (body.reportType !== undefined) update.reportType = body.reportType;
    if (body.reportTypes !== undefined) update.reportTypes = body.reportTypes;
    if (body.frequency !== undefined) update.frequency = body.frequency;
    if (body.hour !== undefined) update.hour = body.hour;
    if (body.minute !== undefined) update.minute = body.minute;
    if (body.dayOfWeek !== undefined) update.dayOfWeek = body.dayOfWeek;
    if (body.dayOfMonth !== undefined) update.dayOfMonth = body.dayOfMonth;
    if (body.timezone !== undefined) update.timezone = body.timezone;
    if (body.recipients !== undefined) update.recipients = body.recipients;
    if (body.zoneId !== undefined) update.zoneId = body.zoneId;
    if (body.zoneName !== undefined) update.zoneName = body.zoneName;
    if (body.accountId !== undefined) update.accountId = body.accountId;
    if (body.accountName !== undefined) update.accountName = body.accountName;
    if (body.timeRange !== undefined) update.timeRange = body.timeRange;
    if (body.format !== undefined) update.format = body.format;
    if (body.subject !== undefined) update.subject = body.subject;

    // Rebuild cron if time fields are present
    if (body.frequency !== undefined || body.hour !== undefined || body.minute !== undefined || body.dayOfWeek !== undefined || body.dayOfMonth !== undefined) {
      const { getSchedules } = await import("@/lib/scheduler");
      const existing = getSchedules().find((s) => s.id === body.id);
      if (!existing) return Response.json({ error: "Schedule not found" }, { status: 404 });
      const freq = (body.frequency ?? existing.frequency) as ScheduleFrequency;
      const hr = body.hour ?? existing.hour;
      const min = body.minute ?? existing.minute ?? 0;
      const dow = body.dayOfWeek ?? existing.dayOfWeek;
      const dom = body.dayOfMonth ?? existing.dayOfMonth;
      update.cronExpression = buildCronExpression(freq, hr, min, dow, dom);
    }

    const { updateSchedule } = await import("@/lib/scheduler");
    const updated = updateSchedule(body.id, update);
    if (!updated) return Response.json({ error: "Schedule not found" }, { status: 404 });

    return Response.json({ success: true, schedule: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update schedule";
    return Response.json({ error: message }, { status: 500 });
  }
}
