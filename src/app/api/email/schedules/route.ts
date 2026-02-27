import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { sessionOptions } from "@/lib/session";
import type { SessionData } from "@/types/cloudflare";
import type { ScheduleFrequency, ReportType } from "@/types/email";
import { getSchedules, addSchedule, deleteSchedule, updateSchedule } from "@/lib/config/config-store";
import { NextRequest } from "next/server";

function validateOrigin(request: NextRequest): Response | null {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return null;
  try {
    if (new URL(origin).host !== host) return Response.json({ error: "Forbidden" }, { status: 403 });
  } catch {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

async function requireAuth(): Promise<boolean> {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  return !!(session.token || process.env.CF_API_TOKEN);
}

function buildCronExpression(frequency: ScheduleFrequency, hour: number, dayOfWeek?: number, dayOfMonth?: number): string {
  switch (frequency) {
    case "daily":
      return `0 ${hour} * * *`;
    case "weekly":
      return `0 ${hour} * * ${dayOfWeek ?? 1}`;
    case "monthly":
      return `0 ${hour} ${dayOfMonth ?? 1} * *`;
    default:
      return `0 ${hour} * * *`;
  }
}

/** GET: List all schedules */
export async function GET() {
  const authed = await requireAuth();
  if (!authed) return Response.json({ error: "Unauthorized" }, { status: 401 });

  return Response.json({ schedules: getSchedules() });
}

interface CreateScheduleBody {
  reportType: ReportType;
  frequency: ScheduleFrequency;
  hour: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  recipients: string[];
  zoneId: string;
  zoneName: string;
  timeRange: "1d" | "7d" | "30d";
  subject?: string;
}

/** POST: Create a new schedule */
export async function POST(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const authed = await requireAuth();
  if (!authed) return Response.json({ error: "Unauthorized" }, { status: 401 });

  if (!process.env.CF_API_TOKEN) {
    return Response.json(
      { error: "CF_API_TOKEN environment variable is required for scheduled email delivery" },
      { status: 400 }
    );
  }

  try {
    const body = await request.json() as CreateScheduleBody;

    if (!body.reportType || !body.frequency || body.hour == null || !body.recipients?.length || !body.zoneId) {
      return Response.json({ error: "Missing required fields" }, { status: 400 });
    }

    if (body.hour < 0 || body.hour > 23) {
      return Response.json({ error: "Hour must be 0-23 (UTC)" }, { status: 400 });
    }

    if (body.recipients.length > 10) {
      return Response.json({ error: "Maximum 10 recipients per schedule" }, { status: 400 });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const email of body.recipients) {
      if (!emailRegex.test(email)) {
        return Response.json({ error: `Invalid email address: ${email}` }, { status: 400 });
      }
    }

    // Limit total schedules
    if (getSchedules().length >= 20) {
      return Response.json({ error: "Maximum 20 schedules allowed" }, { status: 400 });
    }

    const cronExpression = buildCronExpression(body.frequency, body.hour, body.dayOfWeek, body.dayOfMonth);

    const schedule = addSchedule({
      enabled: true,
      reportType: body.reportType,
      frequency: body.frequency,
      cronExpression,
      hour: body.hour,
      dayOfWeek: body.dayOfWeek,
      dayOfMonth: body.dayOfMonth,
      recipients: body.recipients,
      zoneId: body.zoneId,
      zoneName: body.zoneName || body.zoneId,
      timeRange: body.timeRange || "7d",
      subject: body.subject,
    });

    // Notify scheduler of new schedule
    try {
      const { reloadSchedules } = await import("@/lib/scheduler");
      reloadSchedules();
    } catch {
      // Scheduler may not be initialized yet
    }

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

  const authed = await requireAuth();
  if (!authed) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return Response.json({ error: "Missing schedule ID" }, { status: 400 });

  const deleted = deleteSchedule(id);
  if (!deleted) return Response.json({ error: "Schedule not found" }, { status: 404 });

  // Notify scheduler
  try {
    const { reloadSchedules } = await import("@/lib/scheduler");
    reloadSchedules();
  } catch {
    // Scheduler may not be initialized
  }

  return Response.json({ success: true });
}

/** PATCH: Update a schedule (enable/disable) */
export async function PATCH(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const authed = await requireAuth();
  if (!authed) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json() as { id: string; enabled?: boolean };
    if (!body.id) return Response.json({ error: "Missing schedule ID" }, { status: 400 });

    const updated = updateSchedule(body.id, { enabled: body.enabled });
    if (!updated) return Response.json({ error: "Schedule not found" }, { status: 404 });

    // Notify scheduler
    try {
      const { reloadSchedules } = await import("@/lib/scheduler");
      reloadSchedules();
    } catch {
      // Scheduler may not be initialized
    }

    return Response.json({ success: true, schedule: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update schedule";
    return Response.json({ error: message }, { status: 500 });
  }
}
