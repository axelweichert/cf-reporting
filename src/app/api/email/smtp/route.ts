import { getAuthenticatedSession } from "@/lib/auth-helpers";
import { getSmtpFromEnv } from "@/lib/email/smtp-client";

/** GET: Return env SMTP status (no secrets exposed, no session SMTP) */
export async function GET() {
  const session = await getAuthenticatedSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const env = getSmtpFromEnv();

  return Response.json({
    smtp: {
      host: env?.host || "",
      port: env?.port || 587,
      secure: env?.secure ?? true,
      user: env?.user || "",
      passwordSet: !!env?.password,
      fromAddress: env?.fromAddress || "",
      fromName: env?.fromName || "cf-reporting",
      source: env ? "env" : "none",
    },
  });
}
