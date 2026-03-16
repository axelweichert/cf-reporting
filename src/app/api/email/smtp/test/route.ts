import { getAuthenticatedSession, validateOrigin, requireOperator } from "@/lib/auth-helpers";
import { testSmtpConnection, sendTestEmail, getSmtpFromEnv } from "@/lib/email/smtp-client";
import type { InlineSmtpConfig } from "@/types/email";
import { NextRequest } from "next/server";

/** POST: Test SMTP connection or send test email (env SMTP or inline one-shot) */
export async function POST(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const session = await getAuthenticatedSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const operatorError = await requireOperator();
  if (operatorError) return operatorError;

  try {
    const body = await request.json() as { to?: string; smtp?: InlineSmtpConfig };

    // Env SMTP takes precedence; otherwise use inline one-shot config
    const inline = getSmtpFromEnv() ? undefined : body.smtp;

    if (!getSmtpFromEnv() && !inline?.host) {
      return Response.json({ error: "No SMTP configured. Provide SMTP settings or set SMTP_* environment variables." }, { status: 400 });
    }

    if (body.to) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (typeof body.to !== "string" || !emailRegex.test(body.to)) {
        return Response.json({ error: "Invalid email address" }, { status: 400 });
      }
      await sendTestEmail(body.to, inline);
      return Response.json({ success: true, message: `Test email sent to ${body.to}` });
    } else {
      await testSmtpConnection(inline);
      return Response.json({ success: true, message: "SMTP connection successful" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "SMTP test failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
