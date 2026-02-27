import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { sessionOptions } from "@/lib/session";
import type { SessionData } from "@/types/cloudflare";
import { testSmtpConnection, sendTestEmail } from "@/lib/email/smtp-client";
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

/** POST: Test SMTP connection or send test email */
export async function POST(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
  if (!session.token && !process.env.CF_API_TOKEN) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json() as { to?: string };

    if (body.to) {
      // Send a test email
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(body.to)) {
        return Response.json({ error: "Invalid email address" }, { status: 400 });
      }
      await sendTestEmail(body.to);
      return Response.json({ success: true, message: `Test email sent to ${body.to}` });
    } else {
      // Just test the connection
      await testSmtpConnection();
      return Response.json({ success: true, message: "SMTP connection successful" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "SMTP test failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
