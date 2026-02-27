import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import { sessionOptions } from "@/lib/session";
import type { SessionData } from "@/types/cloudflare";
import { getAuthenticatedSession, validateOrigin } from "@/lib/auth-helpers";
import { resolveSmtpConfig, getSmtpFromEnv } from "@/lib/email/smtp-client";
import { NextRequest } from "next/server";

/** GET: Return current SMTP config (password masked) */
export async function GET() {
  const session = await getAuthenticatedSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const smtp = resolveSmtpConfig(session.smtp);

  return Response.json({
    smtp: {
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      user: smtp.user,
      passwordSet: !!smtp.password,
      fromAddress: smtp.fromAddress,
      fromName: smtp.fromName,
      source: smtp.source,
    },
  });
}

/** POST: Save SMTP configuration to session */
export async function POST(request: NextRequest) {
  const originError = validateOrigin(request);
  if (originError) return originError;

  const authSession = await getAuthenticatedSession();
  if (!authSession) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // If env SMTP is set, don't allow UI overrides
  if (getSmtpFromEnv()) {
    return Response.json({ error: "SMTP is configured via environment variables and cannot be changed from the UI" }, { status: 400 });
  }

  try {
    const body = await request.json();

    // Type validation
    if (typeof body.host !== "string" || typeof body.user !== "string" || typeof body.password !== "string" || typeof body.fromAddress !== "string") {
      return Response.json({ error: "Invalid field types" }, { status: 400 });
    }

    if (!body.host || !body.user || !body.password || !body.fromAddress) {
      return Response.json({ error: "Missing required SMTP fields" }, { status: 400 });
    }

    const port = typeof body.port === "number" ? body.port : parseInt(body.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return Response.json({ error: "Invalid port number" }, { status: 400 });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(body.fromAddress)) {
      return Response.json({ error: "Invalid from address" }, { status: 400 });
    }

    // Re-read session to save (getAuthenticatedSession doesn't return a mutable session)
    const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
    session.smtp = {
      host: body.host.trim(),
      port,
      secure: body.secure ?? true,
      user: body.user.trim(),
      password: body.password,
      fromAddress: body.fromAddress.trim(),
      fromName: (typeof body.fromName === "string" ? body.fromName.trim() : "") || "cf-reporting",
    };
    await session.save();

    return Response.json({
      success: true,
      message: "SMTP configuration saved to your session. It will persist until your session expires.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save SMTP configuration";
    return Response.json({ error: message }, { status: 500 });
  }
}
