import { getAuthenticatedSession, validateOrigin } from "@/lib/auth-helpers";
import { testSmtpConnection, sendTestEmail } from "@/lib/email/smtp-client";
import { NextRequest } from "next/server";

/** POST: Test SMTP connection or send test email */
export async function POST(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const session = await getAuthenticatedSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json() as { to?: string };

    if (body.to) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (typeof body.to !== "string" || !emailRegex.test(body.to)) {
        return Response.json({ error: "Invalid email address" }, { status: 400 });
      }
      await sendTestEmail(body.to, session.smtp);
      return Response.json({ success: true, message: `Test email sent to ${body.to}` });
    } else {
      await testSmtpConnection(session.smtp);
      return Response.json({ success: true, message: "SMTP connection successful" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "SMTP test failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
