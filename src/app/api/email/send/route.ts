import { requireAuth, validateOrigin, requireOperator } from "@/lib/auth-helpers";
import type { ReportType, InlineSmtpConfig } from "@/types/email";
import { ACCOUNT_SCOPED_REPORTS } from "@/types/email";
import { sendReportEmail, getSmtpFromEnv } from "@/lib/email/smtp-client";
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
import { NextRequest } from "next/server";

interface SendRequest {
  reportType: ReportType;
  zoneId: string;
  zoneName: string;
  accountId?: string;
  accountName?: string;
  timeRange: "1d" | "7d" | "30d";
  recipients: string[];
  subject?: string;
  smtp?: InlineSmtpConfig;
}

/** POST: Send a report email immediately (env SMTP or inline one-shot) */
export async function POST(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const auth = await requireAuth();
  if (!auth) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const operatorError = await requireOperator();
  if (operatorError) return operatorError;

  const { token } = auth;

  try {
    const body = await request.json() as SendRequest;

    if (!body.reportType || !body.recipients?.length) {
      return Response.json({ error: "Missing required fields: reportType, recipients" }, { status: 400 });
    }

    const isAccountScoped = ACCOUNT_SCOPED_REPORTS.includes(body.reportType);
    if (!isAccountScoped && !body.zoneId) {
      return Response.json({ error: "Missing required field: zoneId" }, { status: 400 });
    }
    if (isAccountScoped && !body.accountId) {
      return Response.json({ error: "Missing required field: accountId for account-scoped report" }, { status: 400 });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const email of body.recipients) {
      if (typeof email !== "string" || !emailRegex.test(email)) {
        return Response.json({ error: `Invalid email address: ${email}` }, { status: 400 });
      }
    }

    // Env SMTP takes precedence; otherwise use inline one-shot config
    const inline = getSmtpFromEnv() ? undefined : body.smtp;

    if (!getSmtpFromEnv() && !inline?.host) {
      return Response.json({ error: "No SMTP configured. Provide SMTP settings or set SMTP_* environment variables." }, { status: 400 });
    }

    const { start, end } = getDateRange(body.timeRange);
    const since = `${start}T00:00:00Z`;
    const until = `${end}T00:00:00Z`;

    const scopeId = isAccountScoped ? (body.accountId || body.zoneId) : body.zoneId;
    const scopeName = isAccountScoped ? (body.accountName || body.zoneName || body.zoneId) : (body.zoneName || body.zoneId);

    const zoneMeta = { zoneName: scopeName, startDate: start, endDate: end };
    const accountMeta = { accountName: scopeName, startDate: start, endDate: end };

    let html: string;
    // Sanitize subject: strip CRLF, limit length
    let subject = typeof body.subject === "string"
      ? body.subject.replace(/[\r\n]/g, "").slice(0, 200)
      : "";

    const defaultSubject = `[cf-reporting] ${body.reportType} – ${scopeName} – ${start} to ${end}`;

    switch (body.reportType) {
      case "executive": {
        const data = await fetchExecutiveDataServer(token, scopeId, since, until);
        html = renderExecutiveEmail(data, zoneMeta);
        break;
      }
      case "security": {
        const data = await fetchSecurityDataServer(token, scopeId, since, until);
        html = renderSecurityEmail(data, zoneMeta);
        break;
      }
      case "traffic": {
        const data = await fetchTrafficDataServer(token, scopeId, since, until);
        html = renderTrafficEmail(data, zoneMeta);
        break;
      }
      case "performance": {
        const data = await fetchPerformanceDataServer(token, scopeId, since, until);
        html = renderPerformanceEmail(data, zoneMeta);
        break;
      }
      case "dns": {
        const data = await fetchDnsDataServer(token, scopeId, since, until);
        html = renderDnsEmail(data, zoneMeta);
        break;
      }
      case "ssl": {
        const data = await fetchSslDataServer(token, scopeId, since, until);
        html = renderSslEmail(data, zoneMeta);
        break;
      }
      case "ddos": {
        const data = await fetchDdosDataServer(token, scopeId, since, until, body.accountId);
        html = renderDdosEmail(data, zoneMeta);
        break;
      }
      case "bots": {
        const data = await fetchBotDataServer(token, scopeId, since, until);
        html = renderBotsEmail(data, zoneMeta);
        break;
      }
      case "origin-health": {
        const data = await fetchOriginHealthDataServer(token, scopeId, since, until);
        html = renderOriginHealthEmail(data, zoneMeta);
        break;
      }
      case "api-shield": {
        const data = await fetchApiShieldDataServer(token, scopeId, since, until);
        html = renderApiShieldEmail(data, zoneMeta);
        break;
      }
      case "zt-summary": {
        const data = await fetchZtSummaryDataServer(token, scopeId, since, until);
        html = renderZtSummaryEmail(data, accountMeta);
        break;
      }
      case "gateway-dns": {
        const data = await fetchGatewayDnsDataServer(token, scopeId, since, until);
        html = renderGatewayDnsEmail(data, accountMeta);
        break;
      }
      case "gateway-network": {
        const data = await fetchGatewayNetworkDataServer(token, scopeId, since, until);
        html = renderGatewayNetworkEmail(data, accountMeta);
        break;
      }
      case "access-audit": {
        const data = await fetchAccessAuditDataServer(token, scopeId, since, until);
        html = renderAccessAuditEmail(data, accountMeta);
        break;
      }
      case "shadow-it": {
        const data = await fetchShadowItDataServer(token, scopeId, since, until);
        html = renderShadowItEmail(data, accountMeta);
        break;
      }
      case "devices-users": {
        const data = await fetchDevicesUsersDataServer(token, scopeId);
        html = renderDevicesUsersEmail(data, accountMeta);
        break;
      }
      default:
        return Response.json(
          { error: `Unsupported report type: ${body.reportType}` },
          { status: 400 }
        );
    }

    if (!subject) subject = defaultSubject;

    await sendReportEmail(body.recipients, subject, html, inline);

    return Response.json({ success: true, message: `Report sent to ${body.recipients.length} recipient(s)` });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send report";
    return Response.json({ error: message }, { status: 500 });
  }
}
