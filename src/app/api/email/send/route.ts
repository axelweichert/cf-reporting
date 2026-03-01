import { requireAuth, validateOrigin } from "@/lib/auth-helpers";
import type { ReportType } from "@/types/email";
import { sendReportEmail } from "@/lib/email/smtp-client";
import { fetchExecutiveDataServer, fetchSecurityDataServer } from "@/lib/email/report-data";
import { renderExecutiveEmail } from "@/lib/email/templates/executive";
import { renderSecurityEmail } from "@/lib/email/templates/security";
import { getDateRange } from "@/lib/store-server";
import { NextRequest } from "next/server";

interface SendRequest {
  reportType: ReportType;
  zoneId: string;
  zoneName: string;
  timeRange: "1d" | "7d" | "30d";
  recipients: string[];
  subject?: string;
}

/** POST: Send a report email immediately */
export async function POST(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const auth = await requireAuth();
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { session, token } = auth;

  try {
    const body = await request.json() as SendRequest;

    if (!body.reportType || !body.zoneId || !body.recipients?.length) {
      return Response.json({ error: "Missing required fields: reportType, zoneId, recipients" }, { status: 400 });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const email of body.recipients) {
      if (typeof email !== "string" || !emailRegex.test(email)) {
        return Response.json({ error: `Invalid email address: ${email}` }, { status: 400 });
      }
    }

    const { start, end } = getDateRange(body.timeRange);
    const since = `${start}T00:00:00Z`;
    const until = `${end}T00:00:00Z`;

    const meta = {
      zoneName: body.zoneName || body.zoneId,
      startDate: start,
      endDate: end,
    };

    let html: string;
    // Sanitize subject: strip CRLF, limit length
    let subject = typeof body.subject === "string"
      ? body.subject.replace(/[\r\n]/g, "").slice(0, 200)
      : "";

    switch (body.reportType) {
      case "executive": {
        const data = await fetchExecutiveDataServer(token, body.zoneId, since, until);
        html = renderExecutiveEmail(data, meta);
        if (!subject) subject = `[cf-reporting] Executive Report – ${meta.zoneName} – ${start} to ${end}`;
        break;
      }
      case "security": {
        const data = await fetchSecurityDataServer(token, body.zoneId, since, until);
        html = renderSecurityEmail(data, meta);
        if (!subject) subject = `[cf-reporting] Security Report – ${meta.zoneName} – ${start} to ${end}`;
        break;
      }
      default:
        return Response.json(
          { error: "Unsupported report type. Supported: executive, security" },
          { status: 400 }
        );
    }

    await sendReportEmail(body.recipients, subject, html, session.smtp);

    return Response.json({ success: true, message: `Report sent to ${body.recipients.length} recipient(s)` });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send report";
    return Response.json({ error: message }, { status: 500 });
  }
}
